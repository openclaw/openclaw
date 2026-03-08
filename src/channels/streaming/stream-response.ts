/**
 * Streaming response abstraction for channel adapters.
 *
 * Provides unified interface for streaming LLM responses to messaging channels.
 */

export interface StreamChunk {
  /** Current accumulated or incremental text */
  text: string;
  /** Whether this is the final chunk */
  isFinal: boolean;
  /** Token count for this chunk (if available) */
  tokenCount?: number;
  /** Sequence number for ordering */
  sequence?: number;
}

export interface StreamResponseHandler {
  /** Handle incoming chunk */
  onChunk(chunk: StreamChunk): Promise<void>;
  /** Called when streaming completes successfully */
  onComplete(): Promise<void>;
  /** Called when streaming is cancelled */
  onCancel(): Promise<void>;
  /** Called on error during streaming */
  onError(err: unknown): Promise<void>;
}

export interface ChannelStreamCapabilities {
  /** Can edit messages in place (e.g., Discord, Slack) */
  supportsInPlaceEdit: boolean;
  /** Can send partial/chunked messages */
  supportsChunkedMessages: boolean;
  /** Can show typing indicators */
  supportsTypingIndicator: boolean;
  /** Maximum message length */
  maxMessageLength: number;
  /** Minimum delay between updates (rate limit protection) */
  minUpdateIntervalMs: number;
}

export interface ChannelStreamAdapter {
  /** Channel identifier */
  readonly channel: string;
  /** Streaming capabilities */
  readonly capabilities: ChannelStreamCapabilities;
  /**
   * Create a stream handler for a conversation.
   *
   * @param conversationId - Target conversation/chat ID
   * @param replyToId - Optional message to reply to
   */
  createStreamHandler(conversationId: string, replyToId?: string): StreamResponseHandler;
}

/** Default capabilities for channels without in-place edit */
export const BASIC_STREAM_CAPABILITIES: ChannelStreamCapabilities = {
  supportsInPlaceEdit: false,
  supportsChunkedMessages: true,
  supportsTypingIndicator: true,
  maxMessageLength: 4096,
  minUpdateIntervalMs: 1000,
};

/** Capabilities for Discord (supports message editing) */
export const DISCORD_STREAM_CAPABILITIES: ChannelStreamCapabilities = {
  supportsInPlaceEdit: true,
  supportsChunkedMessages: true,
  supportsTypingIndicator: true,
  maxMessageLength: 2000,
  minUpdateIntervalMs: 200, // Discord rate limit: 5 edits per 5 seconds
};

/** Capabilities for Slack (supports message updating) */
export const SLACK_STREAM_CAPABILITIES: ChannelStreamCapabilities = {
  supportsInPlaceEdit: true,
  supportsChunkedMessages: true,
  supportsTypingIndicator: false, // Slack typing is limited
  maxMessageLength: 40000,
  minUpdateIntervalMs: 300,
};

/** Capabilities for Telegram (supports edit and draft) */
export const TELEGRAM_STREAM_CAPABILITIES: ChannelStreamCapabilities = {
  supportsInPlaceEdit: true,
  supportsChunkedMessages: true,
  supportsTypingIndicator: true,
  maxMessageLength: 4096,
  minUpdateIntervalMs: 300,
};

/**
 * Stream state for managing update throttling.
 */
export interface StreamState {
  /** Current accumulated text */
  currentText: string;
  /** Last update timestamp */
  lastUpdateAt: number;
  /** Whether stream has completed */
  completed: boolean;
  /** Whether stream was cancelled */
  cancelled: boolean;
  /** Pending update (throttled) */
  pendingUpdate: string | null;
  /** Update timer */
  updateTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Create initial stream state.
 */
export function createStreamState(): StreamState {
  return {
    currentText: "",
    lastUpdateAt: 0,
    completed: false,
    cancelled: false,
    pendingUpdate: null,
    updateTimer: null,
  };
}

/**
 * Create a throttled stream handler that batches updates.
 *
 * @param sendUpdate - Function to send update to channel
 * @param sendFinal - Function to send final message
 * @param capabilities - Channel capabilities
 * @param onError - Error handler
 */
export function createThrottledStreamHandler(params: {
  sendUpdate: (text: string) => Promise<void>;
  sendFinal: (text: string) => Promise<void>;
  capabilities: ChannelStreamCapabilities;
  onError?: (err: unknown) => void;
}): StreamResponseHandler {
  const { sendUpdate, sendFinal, capabilities, onError } = params;
  const state = createStreamState();

  const flushUpdate = async () => {
    if (state.cancelled || state.completed) {
      return;
    }
    if (state.pendingUpdate === null) {
      return;
    }

    const text = state.pendingUpdate;
    state.pendingUpdate = null;
    state.lastUpdateAt = Date.now();

    try {
      await sendUpdate(text);
    } catch (err) {
      onError?.(err);
    }
  };

  const scheduleUpdate = (text: string) => {
    state.pendingUpdate = text;

    if (state.updateTimer) {
      return; // Already scheduled
    }

    const elapsed = Date.now() - state.lastUpdateAt;
    const delay = Math.max(0, capabilities.minUpdateIntervalMs - elapsed);

    state.updateTimer = setTimeout(() => {
      state.updateTimer = null;
      void flushUpdate();
    }, delay);
  };

  return {
    async onChunk(chunk: StreamChunk): Promise<void> {
      if (state.cancelled || state.completed) {
        return;
      }

      state.currentText = chunk.text;

      if (chunk.isFinal) {
        // Don't schedule, will be handled by onComplete
        return;
      }

      if (capabilities.supportsInPlaceEdit) {
        scheduleUpdate(chunk.text);
      }
      // For non-editing channels, we accumulate and send on complete
    },

    async onComplete(): Promise<void> {
      state.completed = true;

      // Clear any pending update
      if (state.updateTimer) {
        clearTimeout(state.updateTimer);
        state.updateTimer = null;
      }

      try {
        await sendFinal(state.currentText);
      } catch (err) {
        onError?.(err);
      }
    },

    async onCancel(): Promise<void> {
      state.cancelled = true;

      if (state.updateTimer) {
        clearTimeout(state.updateTimer);
        state.updateTimer = null;
      }

      // Optionally send what we have so far
      if (state.currentText) {
        try {
          await sendFinal(state.currentText + "\n\n_(cancelled)_");
        } catch {
          // Ignore errors on cancel
        }
      }
    },

    async onError(err: unknown): Promise<void> {
      state.completed = true;

      if (state.updateTimer) {
        clearTimeout(state.updateTimer);
        state.updateTimer = null;
      }

      onError?.(err);
    },
  };
}
