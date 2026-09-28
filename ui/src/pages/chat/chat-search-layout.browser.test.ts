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
const iconSvg = () =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;

describeBrowser("transcript search layout", () => {
  beforeAll(() => layoutBrowser.start());
  afterAll(() => layoutBrowser.close());

  it.each([
    [320, 320],
    [560, 560],
    [1440, 1440],
    [1440, 420],
  ])(
    "keeps transcript search compact and centered at viewport %s and pane %s",
    async (viewportWidth, paneWidth) => {
      await withBrowserPage(openBrowserPage(viewportWidth, 768), async (page) => {
        await page.setContent(`<!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <section class="chat" style="width: ${paneWidth}px">
              <div class="agent-chat__search-bar">
                ${iconSvg()}
                <input type="text" placeholder="Search messages" />
                <openclaw-tooltip><button class="btn btn--ghost" type="button">${iconSvg()}</button></openclaw-tooltip>
              </div>
            </section>
          </body>
        </html>`);

        const searchBar = await getBoundingBox(page, ".agent-chat__search-bar");
        const icons = await page.locator(".agent-chat__search-bar svg").all();
        const input = page.locator(".agent-chat__search-bar input");
        const cornerRadii = await page.locator(".chat").evaluate((chat) => {
          const search = chat.querySelector<HTMLElement>(".agent-chat__search-bar");
          if (!search) {
            throw new Error("Expected transcript search bar");
          }
          const radii = (element: Element) => {
            const style = getComputedStyle(element);
            return [
              style.borderTopLeftRadius,
              style.borderTopRightRadius,
              style.borderBottomRightRadius,
              style.borderBottomLeftRadius,
            ];
          };
          return { chat: radii(chat), search: radii(search) };
        });

        const searchRadius = `${14 * (await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--openclaw-corner-radius-scale"))))}px`;
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
        expect(cornerRadii).toEqual({
          chat: [searchRadius, searchRadius, searchRadius, searchRadius],
          search: [searchRadius, searchRadius, searchRadius, searchRadius],
        });
        expect(icons).toHaveLength(2);
        for (const icon of icons) {
          const box = await icon.boundingBox();
          expect(box?.width).toBeCloseTo(16, 3);
          expect(box?.height).toBeCloseTo(16, 3);
        }
        await input.focus();
        const search = page.locator(".agent-chat__search-bar");
        const focusStyle = () =>
          search.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              shadow: style.boxShadow,
              outline: style.outlineStyle,
              width: style.outlineWidth,
              offset: style.outlineOffset,
            };
          });
        expect(await focusStyle()).toEqual({
          shadow: "none",
          outline: "solid",
          width: "2px",
          offset: "-1px",
        });
        expect(await input.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
          "none",
        );
        await page.keyboard.press("Tab");
        const close = page.locator(".agent-chat__search-bar button");
        await expectBrowser(close).toBeFocused();
        expect(await focusStyle()).toMatchObject({ shadow: "none", outline: "none" });
        expect(await close.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
          "solid",
        );
      });
    },
  );
});
