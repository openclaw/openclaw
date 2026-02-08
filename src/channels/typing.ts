// Discord typing indicators expire after 10 seconds
// Refresh at 8 seconds to keep indicator visible during long operations
const TYPING_HEARTBEAT_INTERVAL_MS = 8000;

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
  let heartbeatInterval: NodeJS.Timeout | null = null;

  const stop = params.stop;

  const startHeartbeat = () => {
    // Clear any existing heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    // Start heartbeat to keep typing indicator alive
    heartbeatInterval = setInterval(async () => {
      try {
        await params.start();
      } catch (err) {
        // Silently ignore heartbeat errors to avoid spam
      }
    }, TYPING_HEARTBEAT_INTERVAL_MS);

    // Prevent heartbeat from keeping process alive
    heartbeatInterval.unref?.();
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const onReplyStart = async () => {
    try {
      await params.start();
      startHeartbeat();
    } catch (err) {
      params.onStartError(err);
    }
  };

  const fireStop = stop
    ? () => {
        stopHeartbeat();
        void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
      }
    : () => {
        stopHeartbeat();
      };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
