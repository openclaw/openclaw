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
  if (job.payload.kind === "agentTurn") {
    // payload.timeoutSeconds is enforced inside the isolated agent run.
    // Keep the outer cron watchdog as an independent safety ceiling so it
    // does not pre-abort provider fallback attempts via the shared signal.
    return AGENT_TURN_SAFETY_TIMEOUT_MS;
  }
  return DEFAULT_JOB_TIMEOUT_MS;
}
