import type { CronJob, CronRunStatus } from "../api/types.ts";

type CronJobLastRunStatus = CronRunStatus | "unknown";
type CronStatusJob = {
  enabled: boolean;
  state?: Pick<
    CronJob["state"],
    "lastRunStatus" | "lastStatus" | "runningAtMs" | "autoDisabled" | "lastMeaningfulResult"
  >;
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

// Quiet checks retain the last meaningful result; they do not resolve a blocker.
// Operator pauses suppress attention, but automatic shutdown remains actionable.
export function resolveCronJobAttention(
  job: CronStatusJob,
): "error" | "blocked" | "needs_attention" | undefined {
  if (job.state?.autoDisabled) {
    return "error";
  }
  if (!job.enabled) {
    return undefined;
  }
  if (resolveCronJobLastRunStatus(job) === "error") {
    return "error";
  }
  const outcome = job.state?.lastMeaningfulResult?.outcome;
  return outcome === "blocked" || outcome === "needs_attention" ? outcome : undefined;
}
