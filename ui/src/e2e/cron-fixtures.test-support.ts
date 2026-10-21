import type { Page } from "playwright";
import { expect } from "vitest";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import type { installMockGateway } from "../test-helpers/control-ui-e2e.ts";

export { createCronRunsResult as cronRuns } from "../lib/cron/cron.test-support.ts";

export function cronJob(id: string, name: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic automation" },
    state: {},
    ...overrides,
  };
}

export function cronList(
  jobs: CronJob[],
  snapshotRevision: string,
  pagination: Partial<Omit<CronJobsListResult, "jobs" | "snapshotRevision">> = {},
): CronJobsListResult {
  return cronJobsListResponse(jobs, { snapshotRevision, ...pagination });
}

export async function openCronHistory(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  jobId: string,
  scope: "all" | "job",
) {
  if (scope === "job") {
    await page.locator('[data-test-id="cron-tab-all"]').click();
    await page.locator(`[data-test-id="cron-row-${jobId}"] .cron-table__name-text`).click();
    await page.locator('[data-test-id="cron-detail-tab-history"]').click();
  }
  await expect
    .poll(
      async () =>
        (
          await gateway.getRequests("cron.runs", {
            scope,
            ...(scope === "job" ? { id: jobId } : {}),
          })
        ).length,
    )
    .toBeGreaterThan(0);
  const history = page.locator(scope === "all" ? ".cron-activity" : ".cron-history");
  await history.waitFor({ state: "visible" });
  return history;
}
