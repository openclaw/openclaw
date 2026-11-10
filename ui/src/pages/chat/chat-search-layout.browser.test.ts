// @vitest-environment node
import { expect as expectBrowser } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  getBoundingBox,
  readUiCss,
} from "./chat-layout.browser.test-support.ts";

const describeBrowser = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
const iconSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;

describeBrowser("transcript search layout", () => {
  beforeAll(() => layoutBrowser.start());
  afterAll(() => layoutBrowser.close());

  it.each([
    [320, 320],
    [560, 560],
    [1440, 1440],
    [1440, 420],
  ])("centers compact search: viewport %s, pane %s", async (viewportWidth, paneWidth) => {
    await withBrowserPage(openBrowserPage(viewportWidth, 768), async (page) => {
      await page.setContent(`<!doctype html>
        <style>${readUiCss()}</style>
        <section class="chat" style="width: ${paneWidth}px">
              <div class="agent-chat__search-bar">
                ${iconSvg}
                <input type="text" placeholder="Search messages" />
                <openclaw-tooltip><button class="btn btn--ghost" type="button">${iconSvg}</button></openclaw-tooltip>
              </div>
        </section>`);

      const searchBar = await getBoundingBox(page, ".agent-chat__search-bar");
      const icons = await page.locator(".agent-chat__search-bar svg").all();
      const input = page.locator(".agent-chat__search-bar input");
      const cornerRadii = await page
        .locator(".chat, .agent-chat__search-bar")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            return ["top-left", "top-right", "bottom-right", "bottom-left"].map((corner) =>
              style.getPropertyValue(`border-${corner}-radius`),
            );
          }),
        );
      const css = (selector: string, properties: string) =>
        page.locator(selector).evaluate((node, keys) => {
          const style = getComputedStyle(node);
          return keys.split(" ").map((key) => style.getPropertyValue(key));
        }, properties);
      const [scale] = await css("html", "--openclaw-corner-radius-scale");
      const chat = await getBoundingBox(page, ".chat");
      const inputBox = await getBoundingBox(page, ".agent-chat__search-bar input");
      const closeButton = await getBoundingBox(page, ".agent-chat__search-bar button");
      expect(searchBar.height).toBeLessThan(64);
      expect(searchBar.width).toBeLessThanOrEqual(560);
      expect(searchBar.x - chat.x).toBeGreaterThanOrEqual(16);
      expect(searchBar.x + searchBar.width / 2).toBeCloseTo(chat.x + chat.width / 2, 1);
      expect(inputBox.width).toBeGreaterThan(100);
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(closeButton.x);
      expect(closeButton.x + closeButton.width).toBeLessThan(searchBar.x + searchBar.width);
      const expectedRadii = Array<string>(4).fill(`${14 * Number(scale)}px`);
      expect(cornerRadii).toEqual([expectedRadii, expectedRadii]);
      expect(icons).toHaveLength(2);
      for (const icon of icons) {
        const box = await icon.boundingBox();
        expect(box?.width).toBeCloseTo(16, 3);
        expect(box?.height).toBeCloseTo(16, 3);
      }
      await input.focus();
      const focusStyle = () =>
        css(".agent-chat__search-bar", "box-shadow outline-style outline-width outline-offset");
      expect(await focusStyle()).toEqual(["none", "solid", "2px", "-1px"]);
      expect(await css("input", "outline-style")).toEqual(["none"]);
      await page.keyboard.press("Tab");
      const close = page.locator(".agent-chat__search-bar button");
      await expectBrowser(close).toBeFocused();
      expect((await focusStyle()).slice(0, 2)).toEqual(["none", "none"]);
      expect(await css("button", "outline-style")).toEqual(["solid"]);
    });
  });
});
