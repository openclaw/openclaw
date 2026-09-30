import type { CronJob, CronRunStatus } from "../api/types.ts";

type CronJobLastRunStatus = CronRunStatus | "unknown";
type CronStatusJob = {
  enabled: boolean;
  state?: Pick<CronJob["state"], "lastRunStatus" | "lastStatus" | "runningAtMs" | "autoDisabled">;
};

export function resolveCronJobLastRunStatus(
  job: Pick<CronStatusJob, "state">,
): CronJobLastRunStatus {
  return job.state?.lastRunStatus ?? job.state?.lastStatus ?? "unknown";
}

// The gateway intentionally leaves nextRunAtMs past-due while a run executes
// (it only advances on the outcome), so "overdue" surfaces must not flag a
// job that is actively running. runningAtMs is the recorded fact for that.
export function isCronJobRunning(job: Pick<CronStatusJob, "state">): boolean {
  const runningAtMs = job.state?.runningAtMs;
  return typeof runningAtMs === "number" && Number.isFinite(runningAtMs);
}

// "Failed cron" surfaces (cron page, sidebar attention chips) track current
// actionability, so a failure only counts while the job is still enabled —
// with one exception: auto-disabled jobs are the ESCALATED failure state, not
// an operator pause, so hiding them would drop the problem from every failure
// surface exactly when it became permanent. Operator-paused jobs keep their
// historical `lastRunStatus: "error"` for detail views without being flagged.
export function isCronJobActiveFailure(job: CronStatusJob): boolean {
  if (job.state?.autoDisabled) {
    return true;
  }
  return job.enabled && resolveCronJobLastRunStatus(job) === "error";
}
