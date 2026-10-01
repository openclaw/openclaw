import type { HeartbeatWakeRequest } from "../infra/heartbeat-wake-contracts.js";

/** Project a cron wake without losing its live scheduler notification ownership. */
export function normalizeCronHeartbeatWake(
  opts: HeartbeatWakeRequest,
  target: Pick<HeartbeatWakeRequest, "agentId" | "sessionKey">,
): HeartbeatWakeRequest {
  // Untargeted monitor ticks resolve their configured session in the runner.
  const useConfiguredSession = opts.source === "interval" && !opts.sessionKey?.trim();
  return {
    source: opts.source,
    intent: opts.intent,
    reason: opts.reason,
    agentId: target.agentId,
    sessionKey: useConfiguredSession ? undefined : target.sessionKey,
    heartbeat:
      opts.heartbeat?.target === "last"
        ? { ...opts.heartbeat, to: undefined, accountId: undefined }
        : opts.heartbeat,
    ...(opts.scheduledEveryMs !== undefined ? { scheduledEveryMs: opts.scheduledEveryMs } : {}),
    ...(opts.failureNotificationOwners?.length
      ? { failureNotificationOwners: opts.failureNotificationOwners }
      : {}),
    ...(opts.tasks?.length ? { tasks: opts.tasks } : {}),
  };
}
