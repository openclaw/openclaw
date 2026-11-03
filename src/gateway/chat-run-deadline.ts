import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs,
    graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const safeNow = asDateTimestampMs(now);
  if (safeNow === undefined) {
    return 0;
  }
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const targetDurationMs = boundedTimeoutMs + graceMs;
  const target = resolveExpiresAtMsFromDurationMs(targetDurationMs, { nowMs: safeNow });
  const min = resolveExpiresAtMsFromDurationMs(minMs, { nowMs: safeNow });
  const max = resolveExpiresAtMsFromDurationMs(maxMs, { nowMs: safeNow });
  if (target === undefined || min === undefined || max === undefined) {
    return 0;
  }
  return Math.min(max, Math.max(min, target));
}

export function resolveAgentRunExpiresAtMs(params: { now: number; timeoutMs: number }): number {
  return resolveChatRunExpiresAtMs({
    ...params,
    graceMs: DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs: DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    maxMs: Math.max(0, params.timeoutMs) + DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
  });
}
