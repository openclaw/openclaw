import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  editAutomation,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation failure alerts",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("edits failure alerts without changing the result destination", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1360, height: 940 } },
      async ({ page }) => {
        const job = cronJob("weekday-inventory", "Weekday inventory digest", {
          configRevision: "inventory-v1",
          schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "America/Toronto" },
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: "Summarize low-stock items and suggest what to reorder.",
          },
          delivery: { mode: "announce", channel: "last" },
          failureAlert: true,
        });
        const gateway = await installMockGateway(page, {
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: {
            "cron.list": cronList([job], "inventory-list"),
            "cron.get": job,
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 1 },
            "cron.update": { ...job, failureAlert: false },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        await editAutomation(page, job.id);
        await page.locator("details.cron-advanced > summary").click();
        const target = page.getByRole("switch", { name: "Failure alerts", exact: true });
        await target.waitFor();
        expect(await target.isChecked()).toBe(true);
        await target.click();
        await expect.poll(() => target.isChecked()).toBe(false);
        await page.locator('[data-test-id="cron-submit"]').click();
        expect((await gateway.waitForRequest("cron.update")).params).toMatchObject({
          id: job.id,
          patch: { failureAlert: false, delivery: { mode: "announce", channel: "last" } },
        });
      },
    );
  });
});
