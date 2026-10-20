import { expect, it } from "vitest";
import type { CronRunLogEntry } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList, cronRuns, openCronHistory } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron whole-run completion",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("shows completion outcomes in both history views without changing execution filters", async () => {
    const job = cronJob("synthetic-completion-report", "Synthetic delivery report", {
      createdAtMs: Date.UTC(2026, 8, 20, 12),
      updatedAtMs: Date.UTC(2026, 8, 20, 12),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Prepare a synthetic report." },
      delivery: { mode: "announce", channel: "last" },
    });
    const run = {
      jobId: job.id,
      jobName: job.name,
      action: "finished",
      status: "ok",
    } as const;
    const entries: CronRunLogEntry[] = [
      {
        ts: Date.UTC(2026, 8, 20, 12, 3),
        ...run,
        completionStatus: "failed",
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "Synthetic delivery target unavailable.",
        summary: "Required delivery failed after the report was prepared.",
      },
      {
        ts: Date.UTC(2026, 8, 20, 12, 2),
        ...run,
        completionStatus: "unknown",
        deliveryStatus: "unknown",
        summary: "Delivery confirmation is unavailable for this completed report.",
      },
      {
        ts: Date.UTC(2026, 8, 20, 12, 1),
        ...run,
        completionStatus: "succeeded",
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "Synthetic best-effort delivery failure.",
        summary: "This earlier report used an explicitly best-effort delivery policy.",
      },
    ];
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1_280, height: 900 } },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(cronList([job], "synthetic-completion-report")),
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
          await expect.poll(() => runs.count()).toBe(entries.length);
          const titles = (await runs.locator(".cron-run-entry__title").allTextContents()).map(
            (title) => title.replace(/\s+/g, " ").trim(),
          );
          expect
            .soft(titles, `${scope} completion labels`)
            .toEqual([
              `${job.name} · OK · Error`,
              `${job.name} · OK · Unknown`,
              `${job.name} · OK`,
            ]);
          expect(await runs.nth(0).textContent()).toContain(
            "Synthetic delivery target unavailable.",
          );
          expect(await runs.nth(2).textContent()).toContain(
            "Synthetic best-effort delivery failure.",
          );

          const previousRequests = (await gateway.getRequests("cron.runs")).length;
          const statusFilter = history.locator('[data-filter="status"]');
          await statusFilter.locator(".cron-filter-dropdown__trigger").click();
          await statusFilter.locator('[data-value="option:ok"]').click();
          await expect
            .poll(async () =>
              (await gateway.getRequests("cron.runs")).slice(previousRequests).some((request) => {
                const params = request.params as { statuses?: string[]; scope?: string };
                return params.scope === scope && params.statuses?.join(",") === "ok";
              }),
            )
            .toBe(true);
          await statusFilter.locator('[data-value="command:clear"]').click();
          await page.keyboard.press("Escape");
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
