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
});
