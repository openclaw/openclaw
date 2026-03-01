/**
 * Typing keepalive loop — periodically fires an async tick callback while running.
 *
 * Used by TypingController to maintain the typing indicator on channels that
 * require periodic re-sends (e.g., Discord, Telegram).
 */

export type TypingKeepaliveLoop = {
  /** Start the keepalive interval. No-op if already running or intervalMs <= 0. */
  start: () => void;
  /** Stop the keepalive interval. No-op if not running. */
  stop: () => void;
  /** Returns true while the interval timer is active. */
  isRunning: () => boolean;
};

/**
 * Create a keepalive loop that calls `onTick` every `intervalMs` milliseconds.
 *
 * Errors thrown by `onTick` are swallowed (the loop must not crash the host).
 */
export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: () => Promise<void>;
}): TypingKeepaliveLoop {
  const { intervalMs, onTick } = params;
  let timer: ReturnType<typeof setInterval> | undefined;

  const isRunning = (): boolean => timer !== undefined;

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const start = (): void => {
    if (timer !== undefined) {
      return; // already running
    }
    if (!intervalMs || intervalMs <= 0) {
      return; // disabled
    }
    timer = setInterval(() => {
      void onTick().catch(() => {
        // Errors from onTick are intentionally swallowed — the loop must be resilient.
      });
    }, intervalMs);
  };

  return { start, stop, isRunning };
}
