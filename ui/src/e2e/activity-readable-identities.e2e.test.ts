import { expect } from "playwright/test";
import { it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Activity compact rows",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("truncates long titles and IDs without crowding their status or changing their destination", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const rows = ["running", "queued"].map((status, i) => ({
          key: "agent:main:regionalaccessibilityandinterpretationserviceintegrationreview0" + i,
          label:
            "Regional accessibility and interpretation service rollout — " +
            (i ? "verify captions" : "review translations"),
          sessionId: "review-" + i,
          kind: "direct",
          status,
          hasActiveRun: true,
          updatedAt: Date.now() - i,
        }));
        await installMockGateway(page, { sessions: rows });
        await page.goto(suite.server.baseUrl + "activity?view=live");
        for (const row of rows) {
          const link = page.getByRole("link", { name: new RegExp(row.label) });
          const status = link.locator(".settings-status");
          await expect(status).toHaveText(row.status === "running" ? "Running" : "Queued");
          const statusBounds = (await status.boundingBox())!;
          for (const [selector, fullText] of [
            [".activity-current-work__title", row.label],
            [".activity-current-work__agent", row.key],
          ] as const) {
            const label = link.locator(selector);
            await expect(label).toHaveText(fullText);
            await expect(label).toHaveCSS("white-space", "nowrap");
            await expect(label).toHaveCSS("overflow", "hidden");
            await expect(label).toHaveCSS("text-overflow", "ellipsis");
            expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
            const bounds = (await label.boundingBox())!;
            expect(bounds.x + bounds.width).toBeLessThan(statusBounds.x);
          }
        }
        const queued = page.getByRole("link", { name: new RegExp(rows[1]!.label) });
        const href = await queued.getAttribute("href");
        await queued.tap();
        await expect(page).toHaveURL(new URL(href!, suite.server.baseUrl).toString());
        await page.goBack();
        await expect(queued).toBeVisible();
      },
    ));
});
