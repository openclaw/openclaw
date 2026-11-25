import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("theme-token-consistency-");

fixture.describe("theme token consistency", () => {
  it("preserves disabled cursors and semantic running colors", async () => {
    await fixture.withPage(
      "tokens",
      styleDocument(
        readStyles(
          "styles/base",
          "styles/layout",
          "styles/chat/grouped",
          "pages/chat/components/chat-processes-panel",
        ),
        `
      <div style="cursor:pointer"><button class="chat-reply-attribution__target" disabled>Earlier reply</button></div>
      <div style="--accent: rgb(240, 0, 0); --status-running: rgb(0, 170, 80)">
        <div class="chat-processes__metadata" data-status="running"><span class="chat-processes__status">Running</span></div>
      </div>
    `,
      ),
      async (page) => {
        const cursor = await page
          .locator("button")
          .evaluate((element) => getComputedStyle(element).cursor);
        expect.soft(cursor).toBe("default");
        const color = await page
          .locator(".chat-processes__status")
          .evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
        expect.soft(color).toBe("rgb(0, 170, 80)");
      },
    );
  });
});
