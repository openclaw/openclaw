import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane. Used as the default ceiling for script and
 * systemEvent jobs when no explicit timeoutSeconds is configured.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns can legitimately run much longer than other job kinds.
 * Use a larger safety ceiling for agentTurn jobs when no explicit timeout is set.
 */
export const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000; // 60 minutes

export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const configuredTimeoutMs =
    (job.payload.kind === "agentTurn" || job.payload.kind === "script") &&
    typeof job.payload.timeoutSeconds === "number" &&
    Number.isFinite(job.payload.timeoutSeconds)
      ? Math.floor(job.payload.timeoutSeconds * 1_000)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
