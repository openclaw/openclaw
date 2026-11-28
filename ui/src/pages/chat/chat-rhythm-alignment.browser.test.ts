// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  expectFiniteRect,
  readUiCss,
  waitForLayoutSettled,
} from "./chat-layout.browser.test-support.ts";

const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;

function iconSvg() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>';
}

/** A group thread (avatars shown) above the desktop composer action row. */
function rhythmHtml() {
  return `
    <div class="shell shell--chat">
      <main class="content content--chat">
        <section class="chat">
          <div class="chat-split-container">
            <div class="chat-main" style="flex: 1 1 100%">
              <div class="chat-thread" role="log">
                <div class="chat-thread-inner">
                  <div class="chat-group user chat-group--with-footer">
                    <div class="chat-avatar user">V</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">Keep this visible.</div></div>
                    </div>
                    <div class="chat-group-footer"><span class="chat-sender-name">You</span></div>
                  </div>
                  <div class="chat-group assistant chat-group--with-footer">
                    <div class="chat-avatar assistant">A</div>
                    <div class="chat-group-messages">
                      <div class="chat-bubble"><div class="chat-text">It stays readable.</div></div>
                    </div>
                    <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
                  </div>
                </div>
              </div>
              <div class="agent-chat__composer-shell">
                <div class="agent-chat__input agent-chat__input--chat" data-composer-layout="multiline">
                  <div class="agent-chat__composer-combobox"><textarea placeholder="Message"></textarea></div>
                  <div class="agent-chat__composer-footer">
                    <div class="agent-chat__composer-lead">
                      <details class="agent-chat__attach-menu">
                        <summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary>
                      </details>
                      <button class="chat-controls__inline-select-trigger chat-controls__permission-trigger" aria-label="Permissions: Default">${iconSvg()}<span class="chat-controls__inline-select-label">Default</span></button>
                    </div>
                    <div class="agent-chat__composer-trail">
                      <div class="agent-chat__composer-controls">
                        <details class="chat-controls__inline-select chat-controls__model-picker">
                          <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" aria-label="Chat model: Example"><span class="chat-controls__inline-select-label">Example</span></summary>
                        </details>
                        <details class="chat-controls__inline-select chat-controls__effort-picker">
                          <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" aria-label="Effort"><span class="chat-controls__inline-select-label">Medium</span></summary>
                        </details>
                      </div>
                      <div class="agent-chat__composer-actions">
                        <button class="chat-send-btn chat-send-btn--voice" aria-label="Start voice input">${iconSvg()}</button>
                        <span class="chat-desktop-primary-action"><button class="chat-send-btn chat-send-btn--send" aria-label="Send">${iconSvg()}</button></span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}

function composerPaneHtml(id: string, widthPx: number) {
  return `
    <div style="width: ${widthPx}px; flex: 0 0 auto;">
      <section class="chat" style="height: 240px;">
        <div class="chat-main__conversation-frame">
          <div class="chat-main__conversation">
            <div class="chat-thread"><div class="chat-thread-inner">Transcript</div></div>
            <footer class="chat-footer">
              <div class="agent-chat__composer-shell" data-composer-pane="${id}">
                <div class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar" data-composer-layout="multiline">
                  <div class="agent-chat__composer-input-row">
                    <div class="agent-chat__composer-combobox"><textarea rows="1" placeholder="Message"></textarea></div>
                  </div>
                  <div class="agent-chat__composer-footer">
                    <div class="agent-chat__composer-lead agent-chat__composer-meta">
                      <details class="agent-chat__attach-menu">
                        <summary class="agent-chat__input-btn agent-chat__input-btn--attach" aria-label="Add attachment">${iconSvg()}</summary>
                      </details>
                      <details class="chat-controls__inline-select chat-controls__permission-picker">
                        <summary class="chat-controls__inline-select-trigger chat-controls__permission-trigger chat-controls__permission-trigger--full" aria-label="Permissions: Full access">
                          <span class="chat-controls__permission-icon" aria-hidden="true">${iconSvg()}</span>
                          <span class="chat-controls__inline-select-label chat-controls__permission-label">Full access</span>
                        </summary>
                      </details>
                    </div>
                    <div class="agent-chat__composer-trail">
                      <div class="agent-chat__composer-meta agent-chat__composer-context">
                        <div class="context-usage">
                          <details>
                            <summary class="context-ring" aria-label="Context">
                              <svg class="context-ring__dial" viewBox="0 0 16 16" aria-hidden="true">
                                <circle class="context-ring__track" cx="8" cy="8" r="6.5"></circle>
                                <circle class="context-ring__fill" cx="8" cy="8" r="6.5"></circle>
                              </svg>
                            </summary>
                          </details>
                        </div>
                      </div>
                      <div class="agent-chat__composer-controls">
                        <div class="chat-composer-model-control">
                          <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
                            <details class="chat-controls__inline-select chat-controls__model-picker">
                              <summary class="chat-controls__inline-select-trigger chat-controls__model-trigger" aria-label="Chat model">
                                <span class="chat-controls__inline-select-label">Gemini 4 Neon</span>
                                <span class="chat-controls__inline-select-chevron" aria-hidden="true">${iconSvg()}</span>
                              </summary>
                            </details>
                            <details class="chat-controls__inline-select chat-controls__effort-picker">
                              <summary class="chat-controls__inline-select-trigger chat-controls__effort-trigger" aria-label="Effort">
                                <span class="chat-controls__effort-gauge" aria-hidden="true">${iconSvg()}</span>
                                <span class="chat-controls__inline-select-label">High</span>
                                <span class="chat-controls__inline-select-chevron" aria-hidden="true">${iconSvg()}</span>
                              </summary>
                            </details>
                          </div>
                        </div>
                      </div>
                      <div class="agent-chat__composer-actions">
                        <div class="chat-talk-control">
                          <button class="chat-send-btn chat-send-btn--voice" aria-label="Start voice input">${iconSvg()}</button>
                          <div class="chat-talk-input-picker">
                            <button class="chat-talk-input-picker__trigger" aria-label="Microphone input">${iconSvg()}</button>
                          </div>
                        </div>
                        <span class="chat-mobile-dictation-action">
                          <div class="chat-talk-control">
                            <button class="chat-send-btn chat-send-btn--voice" aria-label="Start mobile voice input">${iconSvg()}</button>
                          </div>
                        </span>
                        <span class="chat-desktop-primary-action">
                          <button class="chat-send-btn chat-send-btn--send" aria-label="Send">${iconSvg()}</button>
                        </span>
                        <span class="chat-mobile-primary-action">
                          <button class="chat-send-btn chat-send-btn--send" aria-label="Send mobile">${iconSvg()}</button>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </footer>
          </div>
        </div>
      </section>
    </div>
  `;
}

describeBrowserLayout("chat rhythm alignment", () => {
  beforeAll(async () => {
    await layoutBrowser.start();
  });

  afterAll(async () => {
    await layoutBrowser.close();
  });

  it.each([
    [1366, 900],
    [1440, 1400],
  ] as const)(
    "mirrors the avatar columns and levels the action row at %sx%s",
    async (width, height) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${rhythmHtml()}</body></html>`,
        );
        await waitForLayoutSettled(page, ".chat-thread-inner, .agent-chat__composer-footer");

        const geometry = await page.evaluate(() => {
          const rectFor = (selector: string) => {
            const node = document.querySelector<HTMLElement>(selector);
            if (!node) {
              throw new Error(`Expected layout element: ${selector}`);
            }
            const { x, y, width: rectWidth, height: rectHeight } = node.getBoundingClientRect();
            return { x, y, width: rectWidth, height: rectHeight };
          };
          return {
            transcript: rectFor(".chat-thread-inner"),
            assistantLane: rectFor(".chat-group.assistant .chat-group-messages"),
            userLane: rectFor(".chat-group.user .chat-group-messages"),
            actionRow: [
              ...document.querySelectorAll<HTMLElement>(
                ".agent-chat__composer-footer :is(.agent-chat__input-btn, .chat-controls__inline-select-trigger, .chat-send-btn)",
              ),
            ]
              .map((node) => node.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0)
              .map((rect) => ({ height: rect.height, centerY: rect.y + rect.height / 2 })),
          };
        });
        for (const rect of [geometry.transcript, geometry.assistantLane, geometry.userLane]) {
          expectFiniteRect(rect);
        }

        // The user's trailing avatar column mirrors the assistant's leading one:
        // both lanes stop the same distance inside the transcript edges.
        const { transcript, assistantLane, userLane } = geometry;
        expect(transcript.x + transcript.width - (userLane.x + userLane.width)).toBeCloseTo(
          assistantLane.x - transcript.x,
          0,
        );

        // Icon buttons, labelled chips and the primary action share one box and
        // one centre line on desktop; touch layouts raise the chips separately.
        expect(geometry.actionRow.length).toBeGreaterThanOrEqual(5);
        const [first] = geometry.actionRow;
        for (const control of geometry.actionRow) {
          expect(control.height).toBe(first!.height);
          expect(control.centerY).toBeCloseTo(first!.centerY, 0);
        }
      });
    },
  );

  it("keeps narrow desktop composers on desktop icon and control sizes while preserving mobile touch scaling", async () => {
    const html = `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
      <div style="display:flex;gap:16px">
        ${composerPaneHtml("wide", 820)}
        ${composerPaneHtml("narrow", 440)}
      </div>
    </body></html>`;

    async function measurePane(
      page: Awaited<ReturnType<typeof openBrowserPage>>,
      selector: string,
    ) {
      return await page.locator(selector).evaluate((root) => {
        const box = (sel: string) => {
          const el = root.querySelector<HTMLElement | SVGElement>(sel);
          if (!el) {
            throw new Error(`Missing composer control: ${sel}`);
          }
          const rect = el.getBoundingClientRect();
          return {
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          };
        };
        const visibleBox = (sel: string) => {
          const el = [...root.querySelectorAll<HTMLElement | SVGElement>(sel)].find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (!el) {
            throw new Error(`Missing visible composer control: ${sel}`);
          }
          const rect = el.getBoundingClientRect();
          return {
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          };
        };
        const label = root.querySelector<HTMLElement>(".chat-controls__permission-label");
        const picker = root.querySelector<HTMLElement>(".chat-talk-input-picker");
        const input = root.querySelector<HTMLElement>(".agent-chat__input");
        if (!label || !picker || !input) {
          throw new Error("Missing expected composer structure");
        }
        return {
          composerHeight: Math.round(input.getBoundingClientRect().height * 100) / 100,
          attachBtn: box(".agent-chat__input-btn--attach"),
          attachSvg: box(".agent-chat__input-btn--attach svg"),
          permSvg: box(".chat-controls__permission-icon svg"),
          permLabelVisible: label.checkVisibility(),
          ctxDial: box(".context-ring__dial"),
          modelTriggerHeight: box(".chat-controls__model-trigger").height,
          modelChevron: box(
            ".chat-controls__model-trigger .chat-controls__inline-select-chevron svg",
          ),
          effortTriggerHeight: box(".chat-controls__effort-trigger").height,
          effortGauge: box(".chat-controls__effort-gauge"),
          effortChevron: box(
            ".chat-controls__effort-trigger .chat-controls__inline-select-chevron svg",
          ),
          micBtn: visibleBox(".chat-send-btn--voice"),
          micSvg: visibleBox(".chat-send-btn--voice > svg"),
          micPickerDisplay: getComputedStyle(picker).display,
          sendBtn: visibleBox(".chat-send-btn--send"),
          sendSvg: visibleBox(".chat-send-btn--send > svg"),
        };
      });
    }

    await withBrowserPage(openBrowserPage(1440, 900), async (page) => {
      await page.setContent(html);
      await waitForLayoutSettled(page, ".agent-chat__composer-footer");
      const [wide, narrow] = await Promise.all([
        measurePane(page, '[data-composer-pane="wide"]'),
        measurePane(page, '[data-composer-pane="narrow"]'),
      ]);

      expect(wide.permLabelVisible).toBe(true);
      expect(narrow.permLabelVisible).toBe(false);
      expect(narrow.composerHeight).toBe(wide.composerHeight);
      expect(narrow.attachBtn).toEqual(wide.attachBtn);
      expect(narrow.attachSvg).toEqual(wide.attachSvg);
      expect(narrow.permSvg).toEqual(wide.permSvg);
      expect(narrow.ctxDial).toEqual(wide.ctxDial);
      expect(narrow.modelTriggerHeight).toBe(wide.modelTriggerHeight);
      expect(narrow.modelChevron).toEqual(wide.modelChevron);
      expect(narrow.effortTriggerHeight).toBe(wide.effortTriggerHeight);
      expect(narrow.effortGauge).toEqual({ width: 16, height: 16 });
      expect(narrow.effortChevron).toEqual(wide.effortChevron);
      expect(narrow.micBtn).toEqual(wide.micBtn);
      expect(narrow.micSvg).toEqual(wide.micSvg);
      expect(narrow.micPickerDisplay).not.toBe("none");
      expect(narrow.sendBtn).toEqual(wide.sendBtn);
      expect(narrow.sendSvg).toEqual(wide.sendSvg);
    });

    await withBrowserPage(openBrowserPage(393, 852), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${composerPaneHtml("mobile", 393)}</body></html>`,
      );
      await waitForLayoutSettled(page, ".agent-chat__composer-footer");
      const mobile = await measurePane(page, '[data-composer-pane="mobile"]');

      expect(mobile.permLabelVisible).toBe(false);
      expect(mobile.modelTriggerHeight).toBeGreaterThanOrEqual(43.5);
      expect(mobile.effortTriggerHeight).toBeGreaterThanOrEqual(43.5);
      expect(mobile.attachBtn).toEqual({ width: 36, height: 36 });
      expect(mobile.ctxDial).toEqual({ width: 16, height: 16 });
      expect(mobile.effortGauge).toEqual({ width: 20, height: 20 });
      expect(mobile.modelChevron).toEqual({ width: 14, height: 14 });
      expect(mobile.micSvg).toEqual({ width: 20, height: 20 });
      expect(mobile.micPickerDisplay).toBe("none");
    });
  });
});
