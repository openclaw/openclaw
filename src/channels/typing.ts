import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";
import { createTypingStartGuard } from "./typing-start-guard.js";

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
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
};

export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = params.maxDurationMs ?? 60_000; // Default 60s TTL
  type StartResult = "started" | "skipped" | "failed" | "tripped";
  type StartHandle = {
    pending: boolean;
    promise: Promise<StartResult>;
  };
  let stopSent = false;
  let closed = false;
  const pendingStarts = new Set<StartHandle>();
  let stopRequestedDuringPendingStart = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();
    },
  });

  const handleStartSettled = (handle: StartHandle, result: StartResult) => {
    pendingStarts.delete(handle);
    if (closed) {
      // Persistent indicators can record their removable state only after start resolves.
      if (result === "started" && stopRequestedDuringPendingStart) {
        sendStop(true);
      }
      return false;
    }
    return true;
  };

  const fireStart = (onSettled?: (result: StartResult, shouldContinue: boolean) => void) => {
    const handle: StartHandle = {
      pending: true,
      promise: Promise.resolve("skipped" as StartResult),
    };
    handle.promise = startGuard
      .run(async () => {
        try {
          await params.start();
        } finally {
          handle.pending = false;
        }
      })
      .finally(() => {
        handle.pending = false;
      });
    pendingStarts.add(handle);
    void handle.promise.then((result) => {
      const shouldContinue = handleStartSettled(handle, result);
      onSettled?.(result, shouldContinue);
    });
    return handle;
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: async () => {
      await fireStart().promise;
    },
  });

  // TTL safety: auto-stop typing after maxDurationMs
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
    stopSent = false;
    startGuard.reset();
    keepaliveLoop.stop();
    clearTtlTimer();
    fireStart((_, shouldContinue) => {
      if (!shouldContinue) {
        return;
      }
      if (closed || startGuard.isTripped()) {
        return;
      }
      keepaliveLoop.start();
      startTtlTimer();
    });
    await Promise.resolve();
  };

  const sendStop = (allowDuplicate = false) => {
    if (!stop || (stopSent && !allowDuplicate)) {
      return;
    }
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  const fireStop = () => {
    if ([...pendingStarts].some((start) => start.pending)) {
      stopRequestedDuringPendingStart = true;
    }
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer(); // Clear TTL timer on normal stop
    sendStop();
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
