import {
  parseFiniteNumber,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
  /**
   * Opens another start/stop generation after this one has closed.
   * The returned function stops only that generation, so a sealed
   * predecessor cannot clear the successor's indicator.
   */
  beginNextLifecycle?: () => () => void;
};

export type CreateTypingCallbacksParams = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
  /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;
};

const DEFAULT_MAX_CONSECUTIVE_TYPING_FAILURES = 2;

function resolvePositiveIntegerOption(value: number | undefined, fallback: number): number {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined || parsed <= 0 ? fallback : Math.max(1, Math.floor(parsed));
}

export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = resolveTimerTimeoutMs(params.keepaliveIntervalMs, 3_000, 0);
  const maxConsecutiveFailures = resolvePositiveIntegerOption(
    params.maxConsecutiveFailures,
    DEFAULT_MAX_CONSECUTIVE_TYPING_FAILURES,
  );
  const maxDurationMs = resolveTimerTimeoutMs(params.maxDurationMs, 60_000, 0);
  let closed = false;
  let epoch = 0;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  let consecutiveFailures = 0;
  let tripped = false;
  const startTyping = async (): Promise<void> => {
    if (closed || tripped) {
      return;
    }
    try {
      await params.start();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      params.onStartError(error);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        tripped = true;
        keepaliveLoop.stop();
      }
    }
  };
  // Explicit refreshes and keepalive ticks share this gate so one stalled
  // provider request cannot fan out into unbounded concurrent starts.
  let startInFlight: Promise<void> | undefined;

  const fireStart = async (): Promise<void> => {
    const pending = (startInFlight ??= startTyping());
    try {
      await pending;
    } finally {
      if (startInFlight === pending) {
        startInFlight = undefined;
      }
    }
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
  });

  const stopEpoch = (target: number) => {
    if (epoch !== target || closed) {
      return;
    }
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer();
    if (!stop) {
      return;
    }
    const stopIfCurrent = () => {
      if (epoch !== target) {
        return;
      }
      return stop();
    };
    // An admitted start may publish activity after cleanup. Its terminal stop
    // must follow that work so late acknowledgments cannot leave typing visible.
    void Promise.resolve(startInFlight ? startInFlight.then(stopIfCurrent) : stopIfCurrent()).catch(
      (err: unknown) => (params.onStopError ?? params.onStartError)(err),
    );
  };

  const startTtlTimer = () => {
    if (maxDurationMs <= 0) {
      return;
    }
    const target = epoch;
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (epoch === target && !closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        stopEpoch(target);
      }
    }, maxDurationMs);
    ttlTimer.unref?.();
  };

  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    const startEpoch = epoch;
    consecutiveFailures = 0;
    tripped = false;
    clearTtlTimer();
    const startPromise = fireStart();
    void startPromise.then(() => {
      if (closed || tripped || epoch !== startEpoch) {
        return;
      }
      // Core can refresh an active reply independently of this channel loop.
      // Restarting the interval here shifts its deadline and can outlive a
      // provider's visible typing window between consecutive renewals.
      keepaliveLoop.start();
      startTtlTimer();
    });
    await Promise.resolve();
  };

  // The initial dispatch owns epoch 0. Later stops must not target a successor.
  const fireStop = () => {
    stopEpoch(0);
  };

  const beginNextLifecycle = () => {
    epoch += 1;
    closed = false;
    tripped = false;
    consecutiveFailures = 0;
    const target = epoch;
    return () => {
      stopEpoch(target);
    };
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop, beginNextLifecycle };
}
