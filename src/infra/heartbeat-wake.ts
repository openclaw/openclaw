import {
  hasTrustedContinuationHeartbeatWake,
  markTrustedContinuationHeartbeatWake,
  type HeartbeatRunResult,
  type HeartbeatWakeHandler,
  type HeartbeatWakeIntent,
  type HeartbeatWakeOverride,
  type HeartbeatWakeRequest,
  type HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";
import {
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  resetSessionEventWakeStateForTests,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

export type {
  HeartbeatRunResult,
  HeartbeatScheduledTask,
  HeartbeatWakeHandler,
  HeartbeatWakeIntent,
  HeartbeatWakeRequest,
  HeartbeatWakeSource,
} from "./heartbeat-wake-contracts.js";
export {
  hasTrustedContinuationHeartbeatWake,
  markTrustedContinuationHeartbeatWake,
} from "./heartbeat-wake-contracts.js";
export {
  areSessionEventWakesEnabled as areHeartbeatsEnabled,
  setSessionEventWakesEnabled as setHeartbeatsEnabled,
  getSessionEventWakeAbortSignal as getHeartbeatWakeAbortSignal,
  getActiveSessionEventWakeContext as getActiveHeartbeatWakeContext,
  isRetryableSessionEventWakeReason as isRetryableHeartbeatSkipReason,
  SESSION_EVENT_IDLE_RETRY_MS as HEARTBEAT_IDLE_RETRY_GRACE_MS,
} from "./session-event-wake.js";

export const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
export const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
export const HEARTBEAT_SKIP_NO_PENDING_EVENT = "no-pending-event";
export const HEARTBEAT_SKIP_PREEMPTED = "preempted";
export const HEARTBEAT_SKIP_CHANNEL_NOT_READY = "channel-not-ready";
export { isRetryableSessionEventWakeReason as isRetryableHeartbeatBusySkipReason } from "./session-event-wake.js";

type HeartbeatRequestOptions = Omit<HeartbeatWakeRequest, "retainedWork"> & {
  coalesceMs?: number;
};

export function requestHeartbeatRaw(options: HeartbeatRequestOptions): void {
  requestSessionEventWake(options);
}

/** Public scheduler entry point strips non-enumerable internal trust markers. */
export function requestHeartbeat(options: HeartbeatRequestOptions): void {
  requestHeartbeatRaw({ ...options });
}

export function requestHeartbeatAndWait(
  options: HeartbeatRequestOptions,
  lifecycle?: Parameters<typeof requestSessionEventWakeAndWait>[1],
): Promise<HeartbeatRunResult> {
  return requestSessionEventWakeAndWait(options, lifecycle);
}

export function requestHeartbeatNow(options?: {
  source?: HeartbeatWakeSource;
  intent?: HeartbeatWakeIntent;
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
}): void {
  const request = {
    source: options?.source ?? "other",
    intent: options?.intent ?? "immediate",
    reason: options?.reason,
    coalesceMs: options?.coalesceMs,
    agentId: options?.agentId,
    sessionKey: options?.sessionKey,
    parentRunId: options?.parentRunId,
    heartbeat: options?.heartbeat,
  } satisfies HeartbeatRequestOptions;
  if (options && hasTrustedContinuationHeartbeatWake(options)) {
    markTrustedContinuationHeartbeatWake(request);
  }
  requestHeartbeatRaw(request);
}

export function resetHeartbeatWakeStateForTests(): void {
  resetSessionEventWakeStateForTests();
}

// Shipped SDK callers retain their one-argument handler.
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  return setSessionEventWakeHandler(next ? (wake) => next(wake) : null);
}
