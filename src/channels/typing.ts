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
}): TypingCallbacks {
  const stop = params.stop;
  const onReplyStart = async () => {
    try {
      await params.start();
    } catch (err) {
      params.onStartError(err);
    }
  };

  const fireStop = stop
    ? () => {
        void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
      }
    : undefined;

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
