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
    // agentTurn jobs get the large safety ceiling since turns can run for a long time.
    if (job.payload.kind === "agentTurn") {
      return AGENT_TURN_SAFETY_TIMEOUT_MS;
    }
    // systemEvent jobs targeting "main" with wakeMode="now" call runHeartbeatOnce(),
    // which blocks until the full agent turn completes. The turn duration is
    // unbounded, so apply the same generous ceiling as agentTurn jobs instead of
    // the short DEFAULT_JOB_TIMEOUT_MS that was incorrectly timing out long-running
    // main-session heartbeats. See: https://github.com/openclaw/openclaw/issues/50621
    if (
      job.payload.kind === "systemEvent" &&
      job.sessionTarget === "main" &&
      job.wakeMode === "now"
    ) {
      return AGENT_TURN_SAFETY_TIMEOUT_MS;
    }
    // All other systemEvent jobs (wakeMode !== "now") are fire-and-forget:
    // they enqueue the event and return immediately, so the short default is fine.
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
