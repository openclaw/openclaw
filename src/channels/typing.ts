export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

export function createTypingCallbacks(params: {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
}): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3_000;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let keepaliveStartInFlight = false;
  let stopSent = false;

  const fireStart = async () => {
    try {
      await params.start();
    } catch (err) {
      params.onStartError(err);
    }
  };

  const clearKeepalive = () => {
    if (!keepaliveTimer) {
      return;
    }
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
    keepaliveStartInFlight = false;
  };

  const onReplyStart = async () => {
    stopSent = false;
    clearKeepalive();
    await fireStart();
    if (keepaliveIntervalMs <= 0) {
      return;
    }
    keepaliveTimer = setInterval(() => {
      if (keepaliveStartInFlight) {
        return;
      }
      keepaliveStartInFlight = true;
      void fireStart().finally(() => {
        keepaliveStartInFlight = false;
      });
    }, keepaliveIntervalMs);
  };

  const fireStop = () => {
    clearKeepalive();
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
