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
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();
    },
  });

  const fireStart = async (): Promise<void> => {
    await startGuard.run(() => params.start());
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
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
    await fireStart();
    if (startGuard.isTripped()) {
      return;
    }
    keepaliveLoop.start();
    startTtlTimer(); // Start TTL safety timer
  };

  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer(); // Clear TTL timer on normal stop
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}

// =============================================================================
// Unified Typing Signal API (Phase 2)
// =============================================================================

/**
 * Per-channel typing indicator adapter.
 */
export interface TypingAdapter {
  /** Channel identifier */
  readonly channel: string;
  /** Start typing indicator */
  startTyping(conversationId: string): Promise<void>;
  /** Stop typing indicator (if supported) */
  stopTyping(conversationId: string): Promise<void>;
  /** Whether channel supports explicit stop */
  readonly supportsExplicitStop: boolean;
}

/**
 * Unified typing signal across all channels.
 */
export interface TypingSignal {
  /** Start typing on a specific channel and conversation */
  startTyping(channel: string, conversationId: string): Promise<void>;
  /** Stop typing on a specific channel and conversation */
  stopTyping(channel: string, conversationId: string): Promise<void>;
  /** Register a channel adapter */
  registerAdapter(adapter: TypingAdapter): void;
  /** Unregister a channel adapter */
  unregisterAdapter(channel: string): void;
}

/**
 * Typing state for auto-stop functionality.
 */
interface TypingState {
  channel: string;
  conversationId: string;
  startedAt: number;
  autoStopTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Create a unified typing signal that coordinates across channels.
 *
 * @param autoStopMs - Auto-stop typing after this duration (default 30s)
 */
export function createUnifiedTypingSignal(autoStopMs = 30000): TypingSignal {
  const adapters = new Map<string, TypingAdapter>();
  const activeTyping = new Map<string, TypingState>();

  const buildKey = (channel: string, conversationId: string) => `${channel}:${conversationId}`;

  return {
    async startTyping(channel: string, conversationId: string): Promise<void> {
      const adapter = adapters.get(channel);
      if (!adapter) {
        return; // No adapter registered, silently ignore
      }

      const key = buildKey(channel, conversationId);

      // Clear existing auto-stop timer
      const existing = activeTyping.get(key);
      if (existing?.autoStopTimer) {
        clearTimeout(existing.autoStopTimer);
      }

      try {
        await adapter.startTyping(conversationId);
      } catch {
        // Ignore typing errors, not critical
        return;
      }

      // Set auto-stop timer
      const autoStopTimer = setTimeout(() => {
        void this.stopTyping(channel, conversationId);
      }, autoStopMs);
      // Allow process to exit even with timer running (Node.js only)
      const timer = autoStopTimer as unknown as { unref?: () => void };
      timer.unref?.();

      activeTyping.set(key, {
        channel,
        conversationId,
        startedAt: Date.now(),
        autoStopTimer,
      });
    },

    async stopTyping(channel: string, conversationId: string): Promise<void> {
      const key = buildKey(channel, conversationId);
      const state = activeTyping.get(key);

      if (state?.autoStopTimer) {
        clearTimeout(state.autoStopTimer);
      }
      activeTyping.delete(key);

      const adapter = adapters.get(channel);
      if (!adapter?.supportsExplicitStop) {
        return; // Channel doesn't support explicit stop
      }

      try {
        await adapter.stopTyping(conversationId);
      } catch {
        // Ignore typing errors, not critical
      }
    },

    registerAdapter(adapter: TypingAdapter): void {
      adapters.set(adapter.channel, adapter);
    },

    unregisterAdapter(channel: string): void {
      // Stop all active typing for this channel
      for (const [key, state] of activeTyping) {
        if (state.channel === channel) {
          if (state.autoStopTimer) {
            clearTimeout(state.autoStopTimer);
          }
          activeTyping.delete(key);
        }
      }
      adapters.delete(channel);
    },
  };
}

/**
 * Create a typing adapter from simple start/stop functions.
 */
export function createTypingAdapter(params: {
  channel: string;
  startTyping: (conversationId: string) => Promise<void>;
  stopTyping?: (conversationId: string) => Promise<void>;
}): TypingAdapter {
  return {
    channel: params.channel,
    startTyping: params.startTyping,
    stopTyping: params.stopTyping ?? (async () => {}),
    supportsExplicitStop: !!params.stopTyping,
  };
}
