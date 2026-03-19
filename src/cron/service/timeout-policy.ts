import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 */
export const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000; // 60 minutes

export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const configuredTimeoutMs =
    job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
      ? Math.floor(job.payload.timeoutSeconds * 1_000)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    if (job.payload.kind === "agentTurn") {
      return AGENT_TURN_SAFETY_TIMEOUT_MS;
    }
    // systemEvent jobs targeting main with wakeMode=now block while the
    // heartbeat (agent turn) completes.  Apply the agent-turn ceiling so
    // long-running turns are not killed by the 10-min generic cap.
    if (job.sessionTarget === "main" && job.wakeMode === "now") {
      return AGENT_TURN_SAFETY_TIMEOUT_MS;
    }
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
