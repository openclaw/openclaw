import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
  openAutomation,
} from "./cron-fixtures.test-support.ts";

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
          featureMethods: cronSidebarFeatureMethods,
          methodResponses: {
            "cron.list": cronList([job], "waiting"),
            "cron.get": job,
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        await openAutomation(page, job.id);
        const header = page.locator(".cron-detail-header");
        const frame = await takeControlUiScreenshotFrame(page, header, [header], {
          animations: "disabled",
        });
        writeFileSync(artifacts + "/waiting.png", frame.png);
        const subtitle = header.locator(".cron-detail-meta > .cron-detail-sub");
        expect(await subtitle.textContent()).toContain(
          "Waiting: Agent is busy since 11/4/2026, 12:00 PM",
        );
        job.state = { nextRunAtMs: now + 60_000, lastRunAtMs: now, lastRunStatus: "ok" };
        await gateway.setMethodResponse("cron.list", cronList([job], "recovered"));
        await gateway.setMethodResponse("cron.get", job);
        await gateway.emitGatewayEvent("cron", { jobId: job.id, action: "updated" });
        await expect.poll(() => subtitle.textContent()).not.toContain("Waiting");
      },
    );
  });
});
