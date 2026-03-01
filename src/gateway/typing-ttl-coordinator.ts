/**
 * Gateway-level typing indicator TTL coordinator.
 *
 * This is a defense-in-depth safety net for typing indicators. It operates independently
 * of per-session TTL mechanisms already present in TypingController and TypingCallbacks.
 *
 * If all other cleanup mechanisms fail (e.g. dispatcher hangs, event-lane blockage,
 * NO_REPLY path leak, block-streaming edge cases), this coordinator will unconditionally
 * stop typing after a hard TTL and emit a structured warning for diagnostics.
 *
 * Related issues: #27138, #27690, #27011, #26961, #26733, #26751, #27053
 */

export type TypingTtlCoordinatorOptions = {
  /** Hard TTL per session in milliseconds. Default: 120_000 (2 minutes). */
  defaultTtlMs?: number;
  /** Logger for forced-cleanup warnings. Default: console.warn */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * `TypingTtlCoordinator` class.
 *
 * Prefer the process-level singleton (`typingTtlCoordinator`) in production code.
 * Export the class for isolated unit-testing.
 */
export class TypingTtlCoordinator {
  private readonly defaultTtlMs: number;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  private readonly sessions = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: TypingTtlCoordinatorOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 120_000;
    this.warn = options.warn ?? ((msg) => console.warn(msg));
  }

  /**
   * Register a typing session.
   *
   * Returns a bound `deregister` callback that:
   * - Is scoped to this specific registration (captures the timer ref)
   * - Checks `sessions.get(key) === timerRef` before clearing to prevent
   *   stale callbacks from clobbering a newer registration for the same key
   * - Returns `true` if it successfully cancelled the TTL, `false` if already cleared
   *
   * @param key       - Unique session key (e.g. `${channelId}:${sessionKey}`)
   * @param cleanupFn - Idempotent function to stop the typing indicator
   * @param ttlMs     - Hard TTL in milliseconds (default: coordinator default)
   * @returns deregister - call on clean stop to cancel the TTL; returns true if cancelled
   */
  register(key: string, cleanupFn: () => void, ttlMs?: number): () => boolean {
    const resolvedTtlMs = ttlMs ?? this.defaultTtlMs;

    // Cancel any previous registration for this key.
    const existingTimer = this.sessions.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.sessions.delete(key);
    }

    if (resolvedTtlMs <= 0) {
      // TTL disabled — skip scheduling, return a no-op deregister.
      return () => false;
    }

    const timer = setTimeout(() => {
      // Only fire if this timer is still the active registration for this key.
      if (this.sessions.get(key) === timer) {
        this.sessions.delete(key);
        this.warn(`[typing-ttl] TTL expired for key ${key} — forced cleanup`, {
          key,
          ttlMs: resolvedTtlMs,
        });
        try {
          cleanupFn();
        } catch (err) {
          this.warn(`[typing-ttl] cleanupFn threw for key ${key}: ${String(err)}`, { key });
        }
      }
    }, resolvedTtlMs);

    this.sessions.set(key, timer);

    // Capture the timer ref at registration time so this deregister is
    // bound exclusively to this registration, not any future one for the same key.
    const timerRef = timer;

    return (): boolean => {
      // Guard: only clear if this registration's timer is still active for this key.
      if (this.sessions.get(key) !== timerRef) {
        // Already cleared (by TTL expiry or a prior deregister call) — no-op.
        return false;
      }
      clearTimeout(timerRef);
      this.sessions.delete(key);
      return true;
    };
  }

  /** Number of currently active (not yet deregistered or expired) sessions. */
  activeCount(): number {
    return this.sessions.size;
  }
}

/**
 * Process-level singleton typing TTL coordinator.
 *
 * Imported by `createTypingController` to register all active typing sessions.
 * The default TTL is 120 seconds — well above any expected model-run duration,
 * but short enough to prevent typing indicators from persisting indefinitely.
 */
export const typingTtlCoordinator: TypingTtlCoordinator = new TypingTtlCoordinator({
  defaultTtlMs: 120_000,
});
