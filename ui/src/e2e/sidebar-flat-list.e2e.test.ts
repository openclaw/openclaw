import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "A lone session list scrolls instead of paging" });

suite.define(() => {
  it("scrolls the flat list to its last loaded session without Show more", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 700 }, locale: "en-US" },
      async ({ page }) => {
        const sessions = Array.from({ length: 40 }, (_, index) => ({
          key: "agent:main:dashboard:flat-" + index,
          kind: "direct",
          label: "Conversation " + (index + 1),
          updatedAt: 1000 - index,
        }));
        await installMockGateway(page, { sessions, sessionKey: sessions[0]!.key });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "none");
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
        const list = page.locator('[data-session-section="ungrouped"]');
        const body = page.locator(".sidebar-shell__body");
        await list.locator(".sidebar-recent-session").first().waitFor();
        expect(await page.locator(".sidebar-session-pagination").count()).toBe(0);

        const last = list.locator('[data-session-key="agent:main:dashboard:flat-39"]');
        await expect
          .poll(async () => {
            await body.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            const row = await last.boundingBox();
            const scrollBounds = await body.boundingBox();
            return Boolean(
              row &&
              scrollBounds &&
              row.y >= scrollBounds.y &&
              row.y + row.height <= scrollBounds.y + scrollBounds.height,
            );
          })
          .toBe(true);
        expect(await page.locator(".sidebar-session-pagination").count()).toBe(0);
        await captureSidebarUiProof(suite, page, "flat-list-end.png");
      },
    );
  });
});
