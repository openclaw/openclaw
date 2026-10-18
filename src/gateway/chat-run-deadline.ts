import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";

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

/** A new candidate cannot revive a cancelled, expired, or replaced execution. */
export function renewChatRunExecutionDeadline(params: {
  entries: ReadonlyMap<string, ChatAbortControllerEntry>;
  runId: string;
  controller: AbortController;
  timeoutMs: number;
  now?: number;
}): boolean {
  const entry = params.entries.get(params.runId);
  if (entry?.controller !== params.controller || params.controller.signal.aborted) {
    return false;
  }
  if (entry.executionStarted !== true) {
    return false;
  }
  const now = params.now ?? Date.now();
  if (!isFutureDateTimestampMs(entry.expiresAtMs, { nowMs: now })) {
    return false;
  }
  const nextExpiresAtMs = resolveAgentRunExpiresAtMs({ now, timeoutMs: params.timeoutMs });
  if (nextExpiresAtMs <= entry.expiresAtMs) {
    return false;
  }
  entry.expiresAtMs = nextExpiresAtMs;
  return true;
}
