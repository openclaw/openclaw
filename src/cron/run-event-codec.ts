/** Persistence consumes prepared classification without loading provider runtimes. */
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronEvent } from "./types.js";

type CronFinishedEvent = CronEvent & { action: "finished" };

/** Uses execution timing for the timestamp shared by history and runtime state. */
function resolveCronRunEndedAt(event: CronFinishedEvent, fallbackTs: number): number {
  if (
    typeof event.runAtMs === "number" &&
    Number.isFinite(event.runAtMs) &&
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs)
  ) {
    return event.runAtMs + event.durationMs;
  }
  return fallbackTs;
}

/** Builds the legacy run-history record from one finished service event. */
export function cronRunLogEntryFromEvent(
  event: CronFinishedEvent,
  fallbackTs: number,
  errorReason: CronRunLogEntry["errorReason"],
): CronRunLogEntry {
  return {
    ts: resolveCronRunEndedAt(event, fallbackTs),
    jobId: event.jobId,
    action: "finished",
    status: event.status,
    completionStatus: event.completionStatus,
    error: event.error,
    errorReason,
    summary: event.summary,
    result: event.result,
    diagnostics: event.diagnostics,
    delivered: event.delivered,
    deliveryStatus: event.deliveryStatus,
    deliveryError: event.deliveryError,
    deliverySuppressionReason: event.deliverySuppressionReason,
    failureNotificationDelivery: event.failureNotificationDelivery,
    delivery: event.delivery,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    runId: event.runId,
    runAtMs: event.runAtMs,
    durationMs: event.durationMs,
    nextRunAtMs: event.nextRunAtMs,
    triggerFired: event.triggerFired,
    model: event.model,
    provider: event.provider,
    usage: event.usage,
  };
}
