// Control UI module implements cron status behavior.
import type { CronJob, CronRunStatus } from "./types.ts";

export type CronJobLastRunStatus = CronRunStatus | "unknown";

export function resolveCronJobLastRunStatus(job: CronJob): CronJobLastRunStatus {
  return job.state?.lastRunStatus ?? job.state?.lastStatus ?? "unknown";
}

// Overview "failed cron" surfaces track current actionability, so a failure only
// counts while the job is still enabled. Disabled jobs keep their historical
// `lastRunStatus: "error"` for detail views, but a retired job must not be
// reported as an active operational problem.
export function isCronJobActiveFailure(job: CronJob): boolean {
  return job.enabled && resolveCronJobLastRunStatus(job) === "error";
}
