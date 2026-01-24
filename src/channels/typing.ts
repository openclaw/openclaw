export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
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

  const onIdle = stop
    ? () => {
        void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
      }
    : undefined;

  return { onReplyStart, onIdle };
}
