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
  name: "One-shot runtime schedule",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("shows a rearmed one-shot deadline without replacing its authored occurrence on save", async () => {
    const artifacts = createControlUiE2eArtifactDir("cron-one-shot-next-run");
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), timezoneId: "UTC", locale: "en-US" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-10-30T12:05:00Z"));
        const job = cronJob("one-shot-proof", "Check the fictional build", {
          configRevision: "one-shot-proof-revision",
          schedule: { kind: "at", at: "2026-10-30T12:00:00.000Z" },
          sessionTarget: "session:agent:main:build-proof",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: "Check whether the fictional build has finished.",
          },
          deleteAfterRun: true,
          state: {
            lastRunAtMs: Date.parse("2026-10-30T12:00:00Z"),
            lastRunStatus: "ok",
            nextRunAtMs: Date.parse("2026-10-30T12:10:00Z"),
          },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronList([job], "one-shot-proof"),
            "cron.runs": cronRuns([]),
            "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
            "cron.update": { ...job, name: "Check the fictional build again" },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        await page.locator('[data-test-id="cron-row-one-shot-proof"] .cron-table__name').click();
        const input = page.locator("#cron-schedule-at");
        await input.waitFor({ state: "visible" });
        expect(await input.inputValue()).toBe("2026-10-30T12:00");
        const summary = page.locator(".cron-schedule-summary");
        const frame = await takeControlUiScreenshotFrame(page, summary, [summary, input], {
          animations: "disabled",
          scrollTo: summary,
        });
        writeFileSync(artifacts + "/schedule.png", frame.png);
        const summaryText = await summary.textContent();
        writeFileSync(artifacts + "/observed.txt", summaryText ?? "");
        expect(summaryText).toContain("Next run at 10/30/2026, 12:10 PM");
        expect(summaryText).not.toContain("Runs once at");
        await page.locator("#cron-name").fill("Check the fictional build again");
        await page.locator('[data-test-id="cron-submit"]').click();
        await gateway.waitForRequest("cron.update");
        const requests = await gateway.getRequests("cron.update");
        expect(requests.at(-1)?.params).toMatchObject({ id: job.id });
        expect(requests.at(-1)?.params).toHaveProperty("patch");
        expect(requests.at(-1)?.params).not.toHaveProperty("patch.schedule");
        expect(requests.at(-1)?.params).not.toHaveProperty("patch.state");
        await expect.poll(() => input.inputValue()).toBe("2026-10-30T12:00");
        await page.locator('[data-test-id="cron-back"]').click();
        await page.locator('[data-test-id="cron-row-one-shot-proof"] .cron-table__name').click();
        await expect
          .poll(() => summary.textContent())
          .toContain("Next run at 10/30/2026, 12:10 PM");
      },
    );
  });
});
