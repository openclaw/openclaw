/**
 * Lightweight classifier for AbortError instances.
 *
 * During a gateway restart (SIGUSR1) all in-flight fetch requests are aborted.
 * Without classification every AbortError is treated as a transient network
 * failure and retried with the full session context, causing cost spikes.
 *
 * This module distinguishes:
 *   - restart  – gateway SIGUSR1 in progress (should NOT retry)
 *   - user     – explicit user cancellation   (should NOT retry)
 *   - timeout  – request/connection timeout    (may retry with backoff)
 *   - transient – network blip                 (may retry with backoff)
 *
 * See: https://github.com/openclaw/openclaw/issues/17589
 */

import { isGatewayRestarting } from "./restart.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AbortType = "restart" | "user" | "timeout" | "transient";

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Classify an error. Returns `null` when the error is not abort-like.
 */
export function classifyAbort(err: unknown): AbortType | null {
  if (!isAbortLike(err)) {
    return null;
  }

  if (isGatewayRestarting()) {
    return "restart";
  }

  if (isUserCancellation(err)) {
    return "user";
  }

  if (isTimeoutCause(err)) {
    return "timeout";
  }

  return "transient";
}

/**
 * Convenience guard: true when the error is an abort triggered by gateway
 * restart (SIGUSR1). Callers should skip retry and surface a user-friendly
 * message instead.
 */
export function isRestartAbort(err: unknown): boolean {
  return classifyAbort(err) === "restart";
}

/**
 * True when `err` should NOT be retried (restart or explicit user cancel).
 */
export function isNonRetryableAbort(err: unknown): boolean {
  const cls = classifyAbort(err);
  return cls === "restart" || cls === "user";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TIMEOUT_RE = /timeout|timed out|deadline exceeded/i;
const ABORT_MESSAGE = "This operation was aborted";

function isAbortLike(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  // Node's undici sometimes emits this message without the AbortError name.
  if ("message" in err && (err as { message?: string }).message === ABORT_MESSAGE) {
    return true;
  }
  return false;
}

function isUserCancellation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  // AbortSignal.reason may carry a structured cause from the UI layer.
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === "object" && "source" in cause) {
    return (cause as { source?: string }).source === "user";
  }
  return false;
}

function isTimeoutCause(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") {
      return true;
    }
    if (TIMEOUT_RE.test(cause.message)) {
      return true;
    }
  }
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  if (typeof reason === "string" && TIMEOUT_RE.test(reason)) {
    return true;
  }
  return false;
}
