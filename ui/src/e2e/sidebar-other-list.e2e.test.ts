import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Other sessions use the sidebar space" });

suite.define(() => {
  it("shows all 17 Other sessions when they fit and scrolls them after shrinking", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1100 }, locale: "en-US" },
      async ({ page }) => {
        const sessions = Array.from({ length: 17 }, (_, index) => ({
          key: "agent:main:dashboard:other-" + index,
          kind: "direct",
          label: "Conversation " + (index + 1),
          updatedAt: 1000 - index,
        }));
        await installMockGateway(page, {
          sessions: [
            ...sessions,
            {
              key: "agent:main:dashboard:planning",
              kind: "direct",
              label: "Planning",
              category: "Planning",
              updatedAt: 1,
            },
          ],
          sessionKey: sessions[0]!.key,
        });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "category");
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
        const section = page.locator('[data-session-section="ungrouped"]');
        const body = page.locator(".sidebar-shell__body");
        await section.getByRole("button", { name: "Other", exact: true }).waitFor();
        await captureSidebarUiProof(suite, page, "other-fitting.png");
        await expect.poll(() => section.locator(".sidebar-recent-session").count()).toBe(17);
        expect(await section.locator(".sidebar-session-pagination").count()).toBe(0);
        expect(await body.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
          true,
        );
        const last = section.locator('[data-session-key="agent:main:dashboard:other-16"]');
        const bounds = await last.boundingBox();
        const viewport = await body.boundingBox();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);

        await page.setViewportSize({ width: 1280, height: 360 });
        await expect
          .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
          .toBe(true);
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
        await expect
          .poll(() => section.locator(".sidebar-recent-session").count())
          .toBeLessThan(17);
        expect(await section.locator(".sidebar-session-pagination").count()).toBe(0);
        await captureSidebarUiProof(suite, page, "other-overflow.png");
        await section.getByRole("button", { name: "Other", exact: true }).click();
        await expect.poll(() => section.locator(".sidebar-recent-session").count()).toBe(0);
        await section.getByRole("button", { name: "Other", exact: true }).click();
        await expect.poll(() => section.locator(".sidebar-session-window").count()).toBe(1);
      },
    );
  });
});
