import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation run feedback ownership",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("settles the selected detail controls without moving another automation's run feedback", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const job = (id: string, name: string) =>
        cronJob(id, name, {
          configRevision: `synthetic-${id}`,
          payload: { kind: "systemEvent", text: "Synthetic run feedback check" },
        });
      const alpha = job("feedback-alpha", "Alpha synthetic automation");
      const beta = job("feedback-beta", "Beta synthetic automation");
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture(cronList([alpha, beta], "run-feedback-fixture")),
          "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
          "cron.status": { enabled: true, jobs: 2, triggersEnabled: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator(`[data-test-id="cron-row-${alpha.id}"]`).waitFor({ state: "visible" });
      await gateway.deferNext("cron.run", { id: alpha.id, mode: "force" });
      await page.locator(`[data-test-id="cron-row-run-${alpha.id}"]`).click();
      expect((await gateway.waitForRequest("cron.run")).params).toMatchObject({
        id: alpha.id,
        mode: "force",
      });

      await page.locator(`[data-test-id="cron-row-${beta.id}"] .cron-table__name`).click();
      const title = page.locator(".cron-detail-title");
      await expect.poll(() => title.textContent()).toContain(beta.name);
      const selectedRun = page.locator('[data-test-id="cron-run-now"]');
      await expect.poll(() => selectedRun.isEnabled()).toBe(false);
      expect(await page.locator(".cron-error-banner").count()).toBe(0);
      await gateway.resolveDeferred("cron.run", {
        ok: true,
        ran: false,
        reason: "already-running",
      });
      await expect.poll(() => selectedRun.isEnabled()).toBe(true);
      const feedback = (await page.locator(".cron-error-banner").allTextContents()).join("\n");
      expect(feedback).toContain("This automation is already running.");
      expect(feedback).toContain(alpha.name);
      expect(await title.textContent()).toContain(beta.name);
      expect(await gateway.getRequests("cron.run")).toHaveLength(1);
      expect(pageErrors).toEqual([]);
    });
  });
});
