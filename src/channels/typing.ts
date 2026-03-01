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
  /** Stop after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
};

/**
 * Stateless adapter: wraps channel start/stop with a circuit breaker and
 * closed-on-stop dedup. The upstream TypingController owns the single
 * keepalive loop and TTL — this layer just forwards each tick safely.
 */
export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  let stopSent = false;
  let closed = false;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
  });

  const fireStart = async (): Promise<void> => {
    await startGuard.run(() => params.start());
  };

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();
    await fireStart();
    if (startGuard.isTripped()) {
      return;
    }
    // Re-check closed after the async fireStart() — a concurrent fireStop() may have
    // set closed=true while we awaited.
    if (closed) {
      return;
    }
  };

  const fireStop = () => {
    closed = true;
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
