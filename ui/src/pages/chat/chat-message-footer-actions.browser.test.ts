// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  getRect,
  readUiCss,
} from "./chat-layout.browser.test-support.ts";

const describeBrowser = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
const iconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;

describeBrowser("chat message footer actions", () => {
  beforeAll(() => layoutBrowser.start());
  afterAll(() => layoutBrowser.close());

  it.each([
    [390, 844],
    [1366, 900],
  ])("keeps footer action icons in one compact row at %sx%s", async (width, height) => {
    await withBrowserPage(openBrowserPage(width, height), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-group assistant chat-group--with-footer">
            <div class="chat-group-messages">
              <div class="chat-bubble"><div class="chat-text"><p>Done.</p></div></div>
            </div>
            <div class="chat-group-footer">
              <div class="chat-group-footer-actions">
                <button class="chat-reply-btn" type="button" aria-label="Reply">${iconSvg}</button>
                <button class="chat-copy-btn" type="button" aria-label="Copy">${iconSvg}</button>
              </div>
            </div>
          </div>
        </body></html>`,
      );

      // Touch hit areas extend each button without pushing neighboring icons apart.
      const reply = await getRect(page, ".chat-reply-btn");
      const copy = await getRect(page, ".chat-copy-btn");
      expect(copy.left - reply.right).toBeLessThanOrEqual(8);
    });
  });
});
