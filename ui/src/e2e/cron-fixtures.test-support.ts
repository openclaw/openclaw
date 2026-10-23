import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { cronJobsListResponse } from "../lib/cron/cron.test-support.ts";

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
