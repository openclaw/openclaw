import type { CronJob, CronRunStatus } from "../api/types.ts";

type CronJobLastRunStatus = CronRunStatus | "unknown";
type CronStatusJob = {
  enabled: boolean;
  state?: Pick<
    CronJob["state"],
    | "lastRunStatus"
    | "lastStatus"
    | "runningAtMs"
    | "autoDisabled"
    | "lastRunAtMs"
    | "lastTriggerEvalAtMs"
  >;
};

export type CronJobLastActivity = {
  atMs?: number;
  kind: "run" | "trigger-eval" | "none";
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

// Trigger-polled jobs can go days between fires while evaluating every few
// minutes; the newest of lastRunAtMs / lastTriggerEvalAtMs is the honest
// "last activity" for list surfaces.
export function resolveCronJobLastActivity(job: Pick<CronStatusJob, "state">): CronJobLastActivity {
  const lastRunAtMs =
    typeof job.state?.lastRunAtMs === "number" && Number.isFinite(job.state.lastRunAtMs)
      ? job.state.lastRunAtMs
      : undefined;
  const lastTriggerEvalAtMs =
    typeof job.state?.lastTriggerEvalAtMs === "number" &&
    Number.isFinite(job.state.lastTriggerEvalAtMs)
      ? job.state.lastTriggerEvalAtMs
      : undefined;
  if (
    typeof lastTriggerEvalAtMs === "number" &&
    (typeof lastRunAtMs !== "number" || lastTriggerEvalAtMs > lastRunAtMs)
  ) {
    return { atMs: lastTriggerEvalAtMs, kind: "trigger-eval" };
  }
  if (typeof lastRunAtMs === "number") {
    return { atMs: lastRunAtMs, kind: "run" };
  }
  return { kind: "none" };
}

function hasFreshTriggerEvaluation(job: Pick<CronStatusJob, "state">): boolean {
  const lastActivity = resolveCronJobLastActivity(job);
  return lastActivity.kind === "trigger-eval" && typeof lastActivity.atMs === "number";
}

// Mirrors the CLI's computed `status`: a trigger evaluation newer than the
// failed run means the scheduler has since polled the condition successfully,
// so the stale error no longer describes the job's current state.
export function resolveCronJobDisplayStatus(job: CronStatusJob): string {
  if (isCronJobRunning(job)) {
    return "running";
  }
  if (!job.enabled) {
    return "disabled";
  }
  const lastRunStatus = resolveCronJobLastRunStatus(job);
  if (lastRunStatus === "error" && hasFreshTriggerEvaluation(job)) {
    return "idle";
  }
  return lastRunStatus;
}

// "Failed cron" surfaces (cron page, sidebar attention chips) track current
// actionability, so a failure only counts while the job is still enabled —
// with one exception: auto-disabled jobs are the ESCALATED failure state, not
// an operator pause, so hiding them would drop the problem from every failure
// surface exactly when it became permanent. Operator-paused jobs keep their
// historical `lastRunStatus: "error"` for detail views without being flagged,
// and a failure superseded by a newer trigger evaluation is no longer active.
export function isCronJobActiveFailure(job: CronStatusJob): boolean {
  if (job.state?.autoDisabled) {
    return true;
  }
  return resolveCronJobDisplayStatus(job) === "error";
}
