import {
  parseFiniteNumber,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Stable channel/account/conversation identity for opted-in public-audience ownership. */
  backgroundWorkAudienceKey?: string;
  /** Pause this request's visible typing while retaining its exact owner through a known wait. */
  onBackgroundWorkPause?: () => void;
  /** Core installs this only for opted-in background work to retire an owner after its failure guard trips. */
  setBackgroundWorkFailureHandler?: (handler: () => void) => void;
  /** Stop the transport indicator when the typing controller reaches terminal cleanup. */
  onCleanup?: () => void;
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
  /**
   * Explicit opt-in to request-attributed background-work typing. Core retains
   * one keepalive cadence and preserves existing callback recovery when absent.
   */
  backgroundWorkKeepalive?: true;
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
  let pauseGeneration = 0;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;
  let onBackgroundWorkFailure: () => void = () => {};

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
        onBackgroundWorkFailure();
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

  const startTtlTimer = () => {
    if (maxDurationMs <= 0) {
      return;
    }
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        fireStop();
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
    // Background-owned typing spans core refresh callbacks; retain its failure
    // count until a transport start succeeds so the circuit breaker can retire it.
    if (params.backgroundWorkKeepalive !== true) {
      consecutiveFailures = 0;
      tripped = false;
    }
    clearTtlTimer();
    const startGeneration = pauseGeneration;
    const startPromise = fireStart();
    void startPromise.then(() => {
      if (closed || tripped || startGeneration !== pauseGeneration) {
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

  const stopChannelTyping = () => {
    if (!stop) {
      return;
    }
    // An admitted start may publish activity after a pause or cleanup. Its stop
    // must follow that work so late acknowledgments cannot leave typing visible.
    void (startInFlight ? startInFlight.then(stop) : stop()).catch((err: unknown) =>
      (params.onStopError ?? params.onStartError)(err),
    );
  };

  const firePause = () => {
    if (closed) {
      return;
    }
    // An admitted transport start may settle later; it must not rearm a
    // paused audience's cadence or TTL. A genuine resume uses this generation.
    pauseGeneration += 1;
    keepaliveLoop.stop();
    clearTtlTimer();
    stopChannelTyping();
  };

  const fireStop = () => {
    if (closed) {
      return;
    }
    closed = true;
    onBackgroundWorkFailure = () => {};
    keepaliveLoop.stop();
    clearTtlTimer();
    stopChannelTyping();
  };
  if (params.backgroundWorkKeepalive === true) {
    onBackgroundWorkFailure = fireStop;
  }

  return {
    onReplyStart,
    onIdle: fireStop,
    onCleanup: fireStop,
    ...(params.backgroundWorkKeepalive === true
      ? {
          onBackgroundWorkPause: firePause,
          setBackgroundWorkFailureHandler(handler: () => void) {
            onBackgroundWorkFailure = closed ? () => {} : handler;
          },
        }
      : {}),
  };
}
