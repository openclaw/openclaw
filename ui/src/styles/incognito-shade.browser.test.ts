import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("incognito-shade-", { required: true });
const css = readStyles(
  "styles/base",
  "styles/chat/startup-layout",
  "styles/chat/sidebar",
  "styles/chat/split-view",
);

fixture.describe("Incognito pane shade", () => {
  it.each(["light", "dark"])(
    "follows the visible pane, not retained sessions (%s)",
    async (theme) => {
      await fixture.withPage(
        theme,
        styleDocument(
          css,
          `<div class="chat-split-view__cell">
        <div class="chat-pane-cache">
          <openclaw-chat-pane id="private" class="chat-pane-cache__pane" data-incognito="true">
            <div class="agent-chat__input" data-incognito="true"></div>
          </openclaw-chat-pane>
          <openclaw-chat-pane id="regular" class="chat-pane-cache__pane chat-pane-cache__pane--visible">
            <div class="chat-main__conversation"></div><div class="agent-chat__input"></div>
          </openclaw-chat-pane>
        </div>
      </div>`,
          `data-theme-mode="${theme}"`,
        ),
        async (page) => {
          const background = (selector: string) =>
            page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundImage);
          expect(await background(".chat-split-view__cell")).toBe("none");
          expect(await background("#regular")).toBe("none");
          expect(await background("#private")).toBe("none");
          await page.evaluate(() => {
            document.querySelector("#regular")!.classList.remove("chat-pane-cache__pane--visible");
            document.querySelector("#private")!.classList.add("chat-pane-cache__pane--visible");
          });
          expect(await background("#private")).toContain("linear-gradient");
          expect(await background("#regular")).toBe("none");
          expect(await background(".chat-split-view__cell")).toBe("none");
          await page.locator("#private").evaluate((pane) => pane.removeAttribute("data-incognito"));
          expect(await background("#private")).toBe("none");
        },
      );
    },
  );
});
