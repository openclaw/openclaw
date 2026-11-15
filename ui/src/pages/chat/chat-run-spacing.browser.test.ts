// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  readUiCss,
} from "./chat-layout.browser.test-support.ts";

const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;

function iconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
}

function runBlockSpacingHtml() {
  return `
    <div class="chat-thread chat-thread--direct" role="log">
      <div class="chat-thread-inner">
        <div class="chat-group assistant chat-group--with-footer" data-run-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble" data-run-block="text"><div class="chat-text">Opening text</div></div>
            <div class="chat-bubble" data-run-block="detail"><div class="chat-text">Detail text</div></div>
            <div class="chat-bubble chat-bubble--tool-shell" data-run-block="tool">Tool row</div>
            <div class="chat-activity-group" data-run-block="list">
              <div class="chat-activity-group__body">
                <div class="chat-group-messages">
                  <div class="chat-bubble" data-expanded-row="text">Expanded detail</div>
                  <div class="chat-bubble chat-bubble--tool-shell" data-expanded-row="tool">Expanded tool row</div>
                </div>
              </div>
            </div>
            <div class="chat-bubble" data-run-block="activity-reply"><div class="chat-text">Activity result</div></div>
            <div class="chat-activity-group chat-work-group" data-run-block="work">
              <button class="chat-inline-disclosure chat-activity-group__summary" type="button">Worked for 10s</button>
            </div>
            <div class="chat-bubble" data-run-block="reply"><div class="chat-text">Final reply</div></div>
          </div>
          <div class="chat-group-footer">
            <span class="chat-sender-name">Assistant</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group user chat-group--with-footer" data-next-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Next turn</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">You</span></div>
        </div>
        <div class="chat-group user chat-group--with-footer" data-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Persistent identity turn</div></div>
          </div>
          <div class="chat-group-footer chat-group-footer--persistent-identity">
            <span class="chat-sender-name">You</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group assistant chat-group--with-footer" data-after-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">After persistent identity</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
        </div>
        <div class="chat-group user chat-group--with-footer chat-group--meta-revealed" data-revealed-persistent-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">Revealed persistent identity</div></div>
          </div>
          <div class="chat-group-footer chat-group-footer--persistent-identity">
            <span class="chat-sender-name">You</span>
            <div class="chat-group-footer-actions">
              <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg()}</button>
            </div>
          </div>
        </div>
        <div class="chat-group assistant chat-group--with-footer" data-after-revealed-turn>
          <div class="chat-group-messages">
            <div class="chat-bubble"><div class="chat-text">After revealed identity</div></div>
          </div>
          <div class="chat-group-footer"><span class="chat-sender-name">Assistant</span></div>
        </div>
      </div>
    </div>
  `;
}

describeBrowserLayout.concurrent("chat run spacing", () => {
  beforeAll(async () => {
    await layoutBrowser.start();
  });

  afterAll(async () => {
    await layoutBrowser.close();
  });

  it.each([
    { label: "desktop", width: 1366, hasTouch: false },
    { label: "mobile", width: 430, hasTouch: true },
    { label: "wide touch", width: 1366, hasTouch: true },
  ])("keeps transcript turn and run block spacing on $label", async ({ width, hasTouch }) => {
    await withBrowserPage(
      openBrowserPage(width, 900, { hasTouch, isolated: true }),
      async (page) => {
        await page.setContent(
          `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${runBlockSpacingHtml()}</body></html>`,
        );

        const gaps = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          const gap = (before: string, after: string) => rect(after).top - rect(before).bottom;
          return {
            intraTurn: gap('[data-run-block="text"]', '[data-run-block="detail"]'),
            textToTool: gap('[data-run-block="detail"]', '[data-run-block="tool"]'),
            toolToList: gap('[data-run-block="tool"]', '[data-run-block="list"]'),
            listToReply: gap('[data-run-block="list"]', '[data-run-block="activity-reply"]'),
            replyToWork: gap('[data-run-block="activity-reply"]', '[data-run-block="work"]'),
            workToReply: gap('[data-run-block="work"]', '[data-run-block="reply"]'),
            expandedTextToTool: gap('[data-expanded-row="text"]', '[data-expanded-row="tool"]'),
            turn: gap('[data-run-block="reply"]', "[data-next-turn] .chat-bubble"),
            persistentTurn: gap(
              "[data-persistent-turn] .chat-bubble",
              "[data-after-persistent-turn] .chat-bubble",
            ),
            revealedPersistentTurn: gap(
              "[data-revealed-persistent-turn] .chat-bubble",
              "[data-after-revealed-turn] .chat-bubble",
            ),
            simpleToPersistentTurn: gap(
              "[data-next-turn] .chat-bubble",
              "[data-persistent-turn] .chat-bubble",
            ),
          };
        });

        expect(gaps).toEqual({
          intraTurn: 2,
          textToTool: 8,
          toolToList: 8,
          listToReply: 8,
          replyToWork: 8,
          workToReply: 4,
          expandedTextToTool: 6,
          // Footer offset + 24px footer row + turn gap (16px, or 12px on touch).
          turn: hasTouch ? 38 : 42,
          persistentTurn: hasTouch ? 38 : 42,
          revealedPersistentTurn: hasTouch ? 38 : 42,
          simpleToPersistentTurn: hasTouch ? 38 : 42,
        });
      },
    );
  });
});
