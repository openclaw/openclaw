import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture, traceCss } from "./style-fixture.test-support.ts";

const fixture = styleFixture("background-invalidation-", { required: true });

fixture.describe("personal background style scope", () => {
  it("keeps background-style updates scoped away from the sidebar", async () => {
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
        const flushChatStyles = () =>
          page
            .locator(".chat-bubble, .agent-chat__input")
            .evaluateAll((elements) =>
              elements.map((element) => getComputedStyle(element).backgroundImage),
            );
        await flushChatStyles();
        const finishTrace = await traceCss(page);
        await page.locator(".shell").evaluate((shell) => {
          shell.setAttribute("data-background-managed", "");
        });
        await flushChatStyles();
        const recalculated = await finishTrace();
        expect(recalculated.length).toBeGreaterThan(0);
        // Fewer computations than sidebar rows excludes a sidebar-wide invalidation.
        expect(recalculated.reduce((total, count) => total + count, 0)).toBeLessThan(64);
      },
    );
  });
});
