import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cron admission waiting",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("shows the waiting reason and warning without replacing the last run, then clears on recovery", async () => {
    const artifacts = createControlUiE2eArtifactDir("cron-admission-waiting");
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), timezoneId: "UTC", locale: "en-US" },
      async ({ page }) => {
        const now = Date.parse("2026-11-04T12:10:00Z");
        await page.clock.setFixedTime(new Date(now));
        const job = cronJob("waiting-proof", "Reconcile fictional publication", {
          configRevision: "waiting-proof",
          state: {
            nextRunAtMs: now - 600_000,
            lastRunAtMs: now - 660_000,
            lastRunStatus: "ok",
            admissionDeferred: {
              reason: "Agent is busy",
              sinceMs: now - 600_000,
              attempts: 5,
              retryAtMs: now + 60_000,
            },
          },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronList([job], "waiting"),
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        const row = page.locator('[data-test-id="cron-row-waiting-proof"]');
        await row.waitFor({ state: "visible" });
        const frame = await takeControlUiScreenshotFrame(page, row, [row], {
          animations: "disabled",
        });
        writeFileSync(artifacts + "/waiting.png", frame.png);
        expect(await row.textContent()).toContain(
          "Waiting: Agent is busy since 11/4/2026, 12:00 PM",
        );
        expect(await row.locator(".cron-table__state").getAttribute("aria-label")).toContain(
          "Warning",
        );
        expect(await row.locator(".cron-table__last-run").getAttribute("aria-label")).toBe(
          "Completed",
        );
        job.state = { nextRunAtMs: now + 60_000, lastRunAtMs: now, lastRunStatus: "ok" };
        await gateway.setMethodResponse("cron.list", cronList([job], "recovered"));
        await page.locator(".cron-refresh").click();
        await expect.poll(() => row.textContent()).not.toContain("Waiting");
        expect(await row.locator(".cron-table__state").getAttribute("aria-label")).toBe("Active");
      },
    );
  });
});
