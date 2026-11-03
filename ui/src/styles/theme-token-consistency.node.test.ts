import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("theme-token-consistency-");

fixture.describe("theme token consistency", () => {
  it("reserves the same 28px square for workspace marks and agent avatars", async () => {
    await fixture.withPage(
      "avatars",
      styleDocument(
        readStyles("styles/base", "styles/layout"),
        `
      <div class="sidebar-workspace-header__mark"><svg width="24" height="24"></svg></div>
      <span class="sidebar-agent-card__avatar">A</span>
      <span class="sidebar-agent-card__avatar"><img width="80" height="80" alt="" /></span>
    `,
      ),
      async (page) => {
        const sizes = await page
          .locator(".sidebar-workspace-header__mark, .sidebar-agent-card__avatar")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const { width, height } = element.getBoundingClientRect();
              return [width, height];
            }),
          );
        expect(sizes).toEqual([
          [28, 28],
          [28, 28],
          [28, 28],
        ]);
      },
    );
  });

  it("does not inherit a pointer cursor for disabled reply targets", async () => {
    await fixture.withPage(
      "disabled-reply",
      styleDocument(
        readStyles("styles/base", "styles/chat/grouped"),
        `<div style="cursor:pointer"><button class="chat-reply-attribution__target" disabled>Earlier reply</button></div>`,
      ),
      async (page) => {
        const cursor = await page
          .locator("button")
          .evaluate((element) => getComputedStyle(element).cursor);
        expect(cursor).toBe("default");
      },
    );
  });

  it("uses the running status token independently of the accent color", async () => {
    await fixture.withPage(
      "running",
      styleDocument(
        readStyles("styles/base", "pages/chat/components/chat-processes-panel"),
        `
      <div style="--accent: rgb(240, 0, 0); --status-running: rgb(0, 170, 80)">
        <div class="chat-processes__metadata" data-status="running"><span class="chat-processes__status">Running</span></div>
      </div>
    `,
      ),
      async (page) => {
        const color = await page
          .locator(".chat-processes__status")
          .evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
        expect(color).toBe("rgb(0, 170, 80)");
      },
    );
  });
});
