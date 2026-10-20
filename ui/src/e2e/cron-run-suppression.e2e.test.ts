import { expect, it } from "vitest";
import type { CronRunLogEntry } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns, openCronHistory } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron recorded delivery suppression",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("shows recorded suppression independently of delivery failure in both history views", async () => {
    const job = cronJob("delivery-history-proof", "Delivery history proof", {
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check for pending work." },
      delivery: { mode: "announce", channel: "last", bestEffort: true },
    });
    const completedRun = {
      jobId: job.id,
      action: "finished",
      status: "ok",
      completionStatus: "succeeded",
      delivered: false,
      deliveryStatus: "not-delivered",
      summary: "Polling completed.",
    } as const;
    const entries: CronRunLogEntry[] = [
      {
        ts: 4_000,
        ...completedRun,
        deliverySuppressionReason: "silent",
      },
      {
        ts: 3_000,
        ...completedRun,
        deliveryError: "Synthetic delivery target unavailable.",
      },
    ];
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1_280, height: 900 } },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(cronList([job], "delivery-history-proof")),
            "cron.runs": cronRuns(entries),
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 1 },
          },
        });
        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();

        for (const scope of ["all", "job"] as const) {
          const history = await openCronHistory(page, gateway, job.id, scope);
          const runs = history.locator(".cron-run-entry");
          await expect.poll(() => runs.count()).toBe(2);
          const suppressed = runs.nth(0);
          const failedDelivery = runs.nth(1);
          for (const run of [suppressed, failedDelivery]) {
            expect(await run.locator(".cron-run-entry__title").textContent()).toContain("OK");
            expect(await run.locator(".cron-run-entry__facts").textContent()).toContain(
              "Not delivered",
            );
            expect(await run.locator(".cron-run-entry__body").textContent()).toContain(
              "Polling completed.",
            );
          }
          expect(await failedDelivery.textContent()).toContain(
            "Synthetic delivery target unavailable.",
          );
          expect(await failedDelivery.textContent()).not.toContain("Delivery suppression:");
          expect(await suppressed.textContent()).not.toContain(
            "Synthetic delivery target unavailable.",
          );
          // Keep both consumers observable in the original failing run.
          expect
            .soft(await suppressed.textContent(), `${scope} recorded suppression`)
            .toContain("Delivery suppression: silent");
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
