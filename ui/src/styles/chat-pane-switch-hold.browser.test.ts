import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("chat-pane-switch-hold-", { required: true });
const css = readStyles(
  "styles/base",
  "styles/chat/startup-layout",
  "styles/chat/sidebar",
  "styles/chat/split-view",
);

const loader = '<div class="chat-thread-inner"><div class="chat-conversation-loading"></div></div>';
const rows = '<div class="chat-thread-inner"><div class="chat-virtual-row">Reply</div></div>';

fixture.describe("Chat pane session switch", () => {
  it("keeps the previous conversation on screen while a cold destination loads", async () => {
    await fixture.withPage(
      "light",
      styleDocument(
        css,
        `<div class="chat-split-view__cell">
          <div class="chat-pane-cache">
            <openclaw-chat-pane id="old" class="chat-pane-cache__pane chat-pane-cache__pane--visible">${rows}</openclaw-chat-pane>
            <openclaw-chat-pane id="warm" class="chat-pane-cache__pane">${rows}</openclaw-chat-pane>
          </div>
        </div>`,
      ),
      async (page) => {
        const shown = (selector: string) =>
          page.locator(selector).evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              style.visibility !== "hidden" &&
              style.contentVisibility !== "hidden" &&
              Number(style.opacity) > 0.5
            );
          });
        const switchTo = (content: string | null) =>
          page.evaluate((content) => {
            for (const pane of document.querySelectorAll(".chat-pane-cache__pane")) {
              const visible = pane.classList.contains("chat-pane-cache__pane--visible");
              pane.classList.toggle("chat-pane-cache__pane--leaving", visible);
              pane.toggleAttribute("inert", true);
              pane.classList.remove("chat-pane-cache__pane--visible");
            }
            const next =
              content === null
                ? document.querySelector("#warm")!
                : document.createElement("openclaw-chat-pane");
            if (content !== null) {
              next.id = "new";
              next.className = "chat-pane-cache__pane";
              next.innerHTML = content;
              document.querySelector(".chat-pane-cache")!.append(next);
            }
            next.classList.add("chat-pane-cache__pane--visible");
            next.removeAttribute("inert");
          }, content);

        // A cold destination that only shows its loader keeps the old pane painted.
        await switchTo(loader);
        expect(await shown("#old")).toBe(true);
        expect(await shown("#new")).toBe(false);
        expect(
          await page.locator("#old").evaluate((element) => getComputedStyle(element).pointerEvents),
        ).toBe("none");

        // Mounted rows aren't painted until initial scroll positioning finishes.
        await page.locator("#new").evaluate((element, rows) => {
          element.innerHTML = rows;
          element.firstElementChild!.toggleAttribute("data-initial-position-pending", true);
        }, rows);
        expect(await shown("#old")).toBe(true);
        expect(await shown("#new")).toBe(false);

        // The swap happens as soon as the destination can paint its content.
        await page.locator("#new").evaluate((element, rows) => (element.innerHTML = rows), rows);
        expect(await shown("#new")).toBe(true);
        expect(await shown("#old")).toBe(false);

        // A destination that is still loading after the hold appears anyway.
        await page.evaluate(() => document.querySelector("#new")!.remove());
        await page.evaluate(() => {
          document
            .querySelector("#old")!
            .classList.replace("chat-pane-cache__pane--leaving", "chat-pane-cache__pane--visible");
        });
        await switchTo(loader);
        expect(await shown("#old")).toBe(true);
        await page
          .locator("#old")
          .evaluate((pane) => pane.classList.remove("chat-pane-cache__pane--leaving"));
        expect(await shown("#new")).toBe(true);
        expect(await shown("#old")).toBe(false);

        // A retained destination with content switches immediately.
        await page.evaluate(() => {
          document.querySelector("#new")!.remove();
          document.querySelector("#old")!.classList.add("chat-pane-cache__pane--visible");
        });
        await switchTo(null);
        expect(await shown("#warm")).toBe(true);
        expect(await shown("#old")).toBe(false);
      },
    );
  });
});
