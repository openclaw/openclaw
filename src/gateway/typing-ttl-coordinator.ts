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

export type TypingTtlCoordinator = {
  /**
   * Register a typing session. Returns a deregister function — call it on clean stop
   * to cancel the TTL and prevent a spurious forced cleanup.
   *
   * Calling the returned deregister is idempotent.
   * Registering the same key again replaces the previous entry (cancels old TTL).
   *
   * @param key     - Unique session key (e.g. `${channelId}:${sessionKey}`)
   * @param stop    - Idempotent function to stop the typing indicator
   * @param ttlMs   - Hard TTL in milliseconds (default: coordinator default)
   * @returns deregister - call this on clean stop to cancel the TTL
   */
  register: (key: string, stop: () => void, ttlMs?: number) => () => void;

  /** Number of currently active (not yet deregistered or expired) sessions. */
  activeCount: () => number;
};

export type TypingTtlCoordinatorOptions = {
  /** Hard TTL per session in milliseconds. Default: 120_000 (2 minutes). */
  defaultTtlMs?: number;
  /** Logger for forced-cleanup warnings. Default: console.warn */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Create a typing TTL coordinator.
 *
 * Typically you want the process-level singleton (`gatewayTypingTtlCoordinator`).
 * Use this factory for testing or isolated scopes.
 */
export function createTypingTtlCoordinator(
  options: TypingTtlCoordinatorOptions = {},
): TypingTtlCoordinator {
  const defaultTtlMs = options.defaultTtlMs ?? 120_000;
  const warn = options.warn ?? ((msg) => console.warn(msg));

  // Map from session key → active timer
  const sessions = new Map<string, ReturnType<typeof setTimeout>>();

  const deregister = (key: string): void => {
    const timer = sessions.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      sessions.delete(key);
    }
  };

  const register = (key: string, stop: () => void, ttlMs?: number): (() => void) => {
    const resolvedTtlMs = ttlMs ?? defaultTtlMs;

    // Replace any existing registration for this key (e.g. on loop restart).
    deregister(key);

    if (resolvedTtlMs <= 0) {
      // TTL disabled — do not schedule, but still return a no-op deregister.
      return () => {};
    }

    const timer = setTimeout(() => {
      // Only fire if still registered (not already deregistered by clean stop).
      if (sessions.has(key)) {
        sessions.delete(key);
        warn(`[typing-ttl-coordinator] TTL expired for session "${key}" — cleanup missed`, {
          key,
          ttlMs: resolvedTtlMs,
        });
        // Call stop unconditionally. TypingController.cleanup() is idempotent (sealed guard).
        try {
          stop();
        } catch (err) {
          warn(`[typing-ttl-coordinator] stop() threw for session "${key}": ${String(err)}`, {
            key,
          });
        }
      }
    }, resolvedTtlMs);

    sessions.set(key, timer);

    let deregistered = false;
    return () => {
      if (deregistered) {
        return;
      }
      deregistered = true;
      // Only deregister if this specific timer is still the active entry for this key.
      // If the same key was re-registered before this callback fires, sessions.get(key)
      // will point to the newer timer — we must not clear it.
      if (sessions.get(key) === timer) {
        clearTimeout(timer);
        sessions.delete(key);
      }
    };
  };

  const activeCount = (): number => sessions.size;

  return { register, activeCount };
}

/**
 * Process-level singleton typing TTL coordinator.
 *
 * Imported by `createTypingController` to register all active typing sessions.
 * The default TTL is 120 seconds — well above any expected model-run duration,
 * but short enough to prevent typing indicators from persisting indefinitely.
 */
export const gatewayTypingTtlCoordinator: TypingTtlCoordinator = createTypingTtlCoordinator({
  defaultTtlMs: 120_000,
});
