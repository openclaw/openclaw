export const MAX_PAYLOAD_BYTES = 512 * 1024; // cap incoming frame size
export const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024; // per-connection send buffer limit

const DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES = 6 * 1024 * 1024; // keep history responses comfortably under client WS limits
let maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;

export const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;

export const __setMaxChatHistoryMessagesBytesForTest = (value?: number) => {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    return;
  }
  if (value === undefined) {
    maxChatHistoryMessagesBytes = DEFAULT_MAX_CHAT_HISTORY_MESSAGES_BYTES;
    return;
  }
  if (Number.isFinite(value) && value > 0) {
    maxChatHistoryMessagesBytes = value;
  }
};
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const getHandshakeTimeoutMs = () => {
  if (process.env.VITEST && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS) {
    const parsed = Number(process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_HANDSHAKE_TIMEOUT_MS;
};
export const TICK_INTERVAL_MS = 30_000;
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;

// WebSocket send queue/backpressure tuning
export const WS_MAX_QUEUE = 500;
export const WS_BATCH_FLUSH_MS = 300;
export const WS_MAX_FRAME_BYTES = 64 * 1024; // outgoing frame hard cap (64KB)
export const WS_TRUNCATE_PREVIEW_BYTES = 2 * 1024;
export const WS_SLOW_BUFFER_STRIKES = 3;
