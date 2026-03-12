/**
 * Per-connection sliding-window rate limiter for WebSocket messages.
 *
 * Prevents a single WebSocket connection from flooding the gateway with
 * excessive messages. Each connection gets its own tracker created via
 * {@link createWsConnectionRateLimiter}.
 *
 * Limits are configurable. When the limit is exceeded a JSON warning is
 * sent to the client. After {@link WsRateLimitConfig.maxWarnings}
 * consecutive bursts the connection is closed with code 1008 (Policy
 * Violation).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsRateLimitConfig {
  /** Maximum messages allowed inside the sliding window.  @default 100 */
  maxMessages?: number;
  /** Sliding window duration in milliseconds.             @default 10_000 (10 s) */
  windowMs?: number;
  /** Number of warnings before the connection is forcibly closed.  @default 3 */
  maxWarnings?: number;
}

export interface WsRateLimitResult {
  /** Whether the message is allowed to proceed. */
  allowed: boolean;
  /** Number of remaining messages before the limit is reached. */
  remaining: number;
  /** Current warning count (resets when traffic falls below the limit). */
  warnings: number;
  /** True when the connection should be terminated. */
  shouldClose: boolean;
}

export interface WsConnectionRateLimiter {
  /** Record an incoming message and return the rate-limit decision. */
  hit(): WsRateLimitResult;
  /** Reset the limiter (e.g. on reconnect). */
  reset(): void;
  /** Return the current warning count. */
  warningCount(): number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_WINDOW_MS = 10_000; // 10 seconds
const DEFAULT_MAX_WARNINGS = 3;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createWsConnectionRateLimiter(config?: WsRateLimitConfig): WsConnectionRateLimiter {
  const maxMessages = config?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxWarnings = config?.maxWarnings ?? DEFAULT_MAX_WARNINGS;

  let timestamps: number[] = [];
  let warnings = 0;

  function slideWindow(now: number): void {
    const cutoff = now - windowMs;
    timestamps = timestamps.filter((ts) => ts > cutoff);
  }

  function hit(): WsRateLimitResult {
    const now = Date.now();
    slideWindow(now);
    timestamps.push(now);

    const count = timestamps.length;
    const remaining = Math.max(0, maxMessages - count);

    if (count <= maxMessages) {
      // Traffic is within limits – reset warning counter so that occasional
      // bursts don't accumulate across long-lived connections.
      if (warnings > 0 && count <= maxMessages * 0.5) {
        warnings = 0;
      }
      return { allowed: true, remaining, warnings, shouldClose: false };
    }

    // Over the limit.
    warnings += 1;
    const shouldClose = warnings >= maxWarnings;
    return { allowed: false, remaining: 0, warnings, shouldClose };
  }

  function reset(): void {
    timestamps = [];
    warnings = 0;
  }

  function warningCount(): number {
    return warnings;
  }

  return { hit, reset, warningCount };
}
