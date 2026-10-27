import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture, traceCss } from "./style-fixture.test-support.ts";

const fixture = styleFixture("background-invalidation-", { required: true });

fixture.describe("personal background style scope", () => {
  it("updates chat surfaces without restyling the unchanged sidebar", async () => {
    await fixture.withPage(
      "background",
      styleDocument(
        readStyles(
          "styles/base",
          "styles/layout",
          "styles/chat/grouped",
          "styles/chat/composer-surface",
        ),
        `<div class="shell shell--chat"><aside>
          ${Array.from({ length: 64 }, (_, index) => `<div class="sidebar-recent-session"><a>Session ${index}</a><span>Ready</span></div>`).join("")}
          </aside><main><div class="chat-group user"><div class="chat-bubble">Hello</div></div>
          <div class="agent-chat__input">Composer</div></main></div>`,
      ),
      async (page) => {
        const backgrounds = () =>
          page.evaluate(() =>
            [".chat-bubble", ".agent-chat__input"].map(
              (selector) => getComputedStyle(document.querySelector(selector)!).backgroundImage,
            ),
          );
        const initialBackgrounds = await backgrounds();
        expect(initialBackgrounds[0]).toBe("none");
        const finishTrace = await traceCss(page);
        await page.locator(".shell").evaluate((shell) => {
          shell.setAttribute("data-background-managed", "");
        });
        const painted = await backgrounds();
        const recalculated = await finishTrace();
        expect(painted[0]).toMatch(/^linear-gradient\(/u);
        expect(painted[1]).toBe(initialBackgrounds[1]);
        expect(recalculated.length).toBeGreaterThan(0);
        // Fewer computations than sidebar rows excludes a sidebar-wide invalidation.
        expect(recalculated.reduce((total, count) => total + count, 0)).toBeLessThan(64);
      },
    );
  });
});
