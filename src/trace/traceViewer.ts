/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as path from 'path';
import * as util from 'util';
import * as fs from 'fs';
import type { NetworkResourceTraceEvent, ActionTraceEvent, ContextCreatedTraceEvent, ContextDestroyedTraceEvent, PageCreatedTraceEvent, PageDestroyedTraceEvent } from './traceTypes';
import type { FrameSnapshot, PageSnapshot } from './snapshotter';
import type { Browser, BrowserContext, Frame, Page, Route } from '../client/api';
import type { Playwright } from '../client/playwright';

const fsReadFileAsync = util.promisify(fs.readFile.bind(fs));
type TraceEvent =
    ContextCreatedTraceEvent |
    ContextDestroyedTraceEvent |
    PageCreatedTraceEvent |
    PageDestroyedTraceEvent |
    NetworkResourceTraceEvent |
    ActionTraceEvent;

class TraceViewer {
  private _playwright: Playwright;
  private _traceStorageDir: string;
  private _traces: { traceFile: string, events: TraceEvent[] }[] = [];
  private _browserNames = new Set<string>();
  private _resourceEventsByUrl = new Map<string, NetworkResourceTraceEvent[]>();
  private _contextEventById = new Map<string, ContextCreatedTraceEvent>();
  private _contextById = new Map<string, BrowserContext>();

  constructor(playwright: Playwright, traceStorageDir: string) {
    this._playwright = playwright;
    this._traceStorageDir = traceStorageDir;
  }

  async load(traceFile: string) {
    // TODO: validate trace?
    const traceContent = await fsReadFileAsync(traceFile, 'utf8');
    const events = traceContent.split('\n').map(line => line.trim()).filter(line => !!line).map(line => JSON.parse(line));
    for (const event of events) {
      if (event.type === 'context-created')
        this._browserNames.add(event.browserName);
      if (event.type === 'resource') {
        let responseEvents = this._resourceEventsByUrl.get(event.url);
        if (!responseEvents) {
          responseEvents = [];
          this._resourceEventsByUrl.set(event.url, responseEvents);
        }
        responseEvents.push(event);
      }
      if (event.type === 'context-created')
        this._contextEventById.set(event.contextId, event);
    }
    this._traces.push({ traceFile, events });
  }

  browserNames(): Set<string> {
    return this._browserNames;
  }

  async show(browserName: string) {
    const browser = await this._playwright[browserName as ('chromium' | 'firefox' | 'webkit')].launch({ headless: false });
    const uiPage = await browser.newPage();
    await uiPage.exposeBinding('renderSnapshot', async (source, action: ActionTraceEvent) => {
      const snapshot = await fsReadFileAsync(path.join(this._traceStorageDir, action.snapshot!.sha1), 'utf8');
      const context = await this._ensureContext(browser, action.contextId);
      const page = await context.newPage();
      await this._renderSnapshot(page, JSON.parse(snapshot), action.contextId);
    });

    const contextData: { [contextId: string]: { label: string, actions: ActionTraceEvent[] } } = {};
    for (const trace of this._traces) {
      let contextId = 0;
      for (const event of trace.events) {
        if (event.type !== 'action')
          continue;
        const contextEvent = this._contextEventById.get(event.contextId)!;
        if (contextEvent.browserName !== browserName)
          continue;
        let data = contextData[contextEvent.contextId];
        if (!data) {
          data = { label: trace.traceFile + ' :: context' + (++contextId), actions: [] };
          contextData[contextEvent.contextId] = data;
        }
        data.actions.push(event);
      }
    }
    await uiPage.evaluate(traces => {
      function createSection(parent: Element, title: string): HTMLDetailsElement {
        const details = document.createElement('details');
        details.style.paddingLeft = '10px';
        const summary = document.createElement('summary');
        summary.textContent = title;
        details.appendChild(summary);
        parent.appendChild(details);
        return details;
      }

      function createField(parent: Element, text: string) {
        const div = document.createElement('div');
        div.style.whiteSpace = 'pre';
        div.textContent = text;
        parent.appendChild(div);
      }

      for (const trace of traces) {
        const traceSection = createSection(document.body, trace.traceFile);
        traceSection.open = true;

        const contextSections = new Map<string, Element>();
        const pageSections = new Map<string, Element>();

        for (const event of trace.events) {
          if (event.type === 'context-created') {
            const contextSection = createSection(traceSection, event.contextId);
            contextSection.open = true;
            contextSections.set(event.contextId, contextSection);
          }
          if (event.type === 'page-created') {
            const contextSection = contextSections.get(event.contextId)!;
            const pageSection = createSection(contextSection, event.pageId);
            pageSection.open = true;
            pageSections.set(event.pageId, pageSection);
          }
          if (event.type === 'action') {
            const parentSection = event.pageId ? pageSections.get(event.pageId)! : contextSections.get(event.contextId)!;
            const actionSection = createSection(parentSection, event.action);
            if (event.label)
              createField(actionSection, `label: ${event.label}`);
            if (event.target)
              createField(actionSection, `target: ${event.target}`);
            if (event.value)
              createField(actionSection, `value: ${event.value}`);
            if (event.startTime && event.endTime)
              createField(actionSection, `duration: ${event.endTime - event.startTime}ms`);
            if (event.error) {
              const errorSection = createSection(actionSection, 'error');
              createField(errorSection, event.error);
            }
            if (event.stack) {
              const errorSection = createSection(actionSection, 'stack');
              createField(errorSection, event.stack);
            }
            if (event.logs && event.logs.length) {
              const errorSection = createSection(actionSection, 'logs');
              createField(errorSection, event.logs.join('\n'));
            }
            if (event.snapshot) {
              const button = document.createElement('button');
              button.style.display = 'block';
              button.textContent = `snapshot after (${event.snapshot.duration}ms)`;
              button.addEventListener('click', () => (window as any).renderSnapshot(event));
              actionSection.appendChild(button);
            }
          }
        }
      }
    }, this._traces);
  }

  private async _ensureContext(browser: Browser, contextId: string): Promise<BrowserContext> {
    let context = this._contextById.get(contextId);
    if (!context) {
      const event = this._contextEventById.get(contextId)!;
      context = await browser.newContext({
        isMobile: event.isMobile,
        viewport: event.viewportSize || null,
        deviceScaleFactor: event.deviceScaleFactor,
      });
      this._contextById.set(contextId, context);
    }
    return context;
  }

  private async _readResource(event: NetworkResourceTraceEvent, overrideSha1: string | undefined) {
    try {
      const body = await fsReadFileAsync(path.join(this._traceStorageDir, overrideSha1 || event.sha1));
      return {
        contentType: event.contentType,
        body,
        headers: event.responseHeaders,
      };
    } catch (e) {
      return undefined;
    }
  }

  private async _renderSnapshot(page: Page, snapshot: PageSnapshot, contextId: string): Promise<void> {
    const frameBySrc = new Map<string, FrameSnapshot>();
    for (const frameSnapshot of snapshot.frames)
      frameBySrc.set(frameSnapshot.url, frameSnapshot);

    const intercepted: Promise<any>[] = [];

    const unknownUrls = new Set<string>();
    const unknown = (route: Route): void => {
      const url = route.request().url();
      if (!unknownUrls.has(url)) {
        console.log(`Request to unknown url: ${url}`);  /* eslint-disable-line no-console */
        unknownUrls.add(url);
      }
      intercepted.push(route.abort());
    };

    await page.route('**', async route => {
      const url = route.request().url();
      if (frameBySrc.has(url)) {
        const frameSnapshot = frameBySrc.get(url)!;
        intercepted.push(route.fulfill({
          contentType: 'text/html',
          body: Buffer.from(frameSnapshot.html),
        }));
        return;
      }

      const frameSrc = route.request().frame().url();
      const frameSnapshot = frameBySrc.get(frameSrc);
      if (!frameSnapshot)
        return unknown(route);

      // Find a matching resource from the same context, preferrably from the same frame.
      // Note: resources are stored without hash, but page may reference them with hash.
      let resource: NetworkResourceTraceEvent | null = null;
      for (const resourceEvent of this._resourceEventsByUrl.get(removeHash(url)) || []) {
        if (resourceEvent.contextId !== contextId)
          continue;
        if (resource && resourceEvent.frameId !== frameSnapshot.frameId)
          continue;
        resource = resourceEvent;
        if (resourceEvent.frameId === frameSnapshot.frameId)
          break;
      }
      if (!resource)
        return unknown(route);

      // This particular frame might have a resource content override, for example when
      // stylesheet is modified using CSSOM.
      const resourceOverride = frameSnapshot.resourceOverrides.find(o => o.url === url);
      const overrideSha1 = resourceOverride ? resourceOverride.sha1 : undefined;
      const resourceData = await this._readResource(resource, overrideSha1);
      if (!resourceData)
        return unknown(route);
      const headers: { [key: string]: string } = {};
      for (const { name, value } of resourceData.headers)
        headers[name] = value;
      headers['Access-Control-Allow-Origin'] = '*';
      intercepted.push(route.fulfill({
        contentType: resourceData.contentType,
        body: resourceData.body,
        headers,
      }));
    });

    await page.goto(snapshot.frames[0].url);
    await this._postprocessSnapshotFrame(snapshot, snapshot.frames[0], page.mainFrame());
    await Promise.all(intercepted);
  }

  private async _postprocessSnapshotFrame(snapshot: PageSnapshot, frameSnapshot: FrameSnapshot, frame: Frame) {
    for (const childFrame of frame.childFrames()) {
      await childFrame.waitForLoadState();
      const url = childFrame.url();
      for (const childData of snapshot.frames) {
        if (url.endsWith(childData.url))
          await this._postprocessSnapshotFrame(snapshot, childData, childFrame);
      }
    }
  }
}

export async function showTraceViewer(playwright: Playwright, traceStorageDir: string, traceFiles: string[]) {
  const traceViewer = new TraceViewer(playwright, traceStorageDir);
  for (const traceFile of traceFiles)
    await traceViewer.load(traceFile);
  for (const browserName of traceViewer.browserNames())
    await traceViewer.show(browserName);
}

function removeHash(url: string) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch (e) {
    return url;
  }
}
