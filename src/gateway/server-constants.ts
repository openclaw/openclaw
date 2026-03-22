// Keep server maxPayload aligned with gateway client maxPayload so high-res canvas snapshots
// don't get disconnected mid-invoke with "Max payload size exceeded".
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 50 * 1024 * 1024; // per-connection send buffer limit (2x max payload)

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
/**
 * Loopback connections do not incur network RTT, but the event loop can be
 * busy (e.g. a managed browser session, agent turns, or compaction running
 * concurrently on the same host).  A generous loopback-specific ceiling lets
 * the handshake complete under load without falsely declaring the connection
 * dead.  Remote connections keep the shorter default so security-relevant
 * timeouts remain tight.
 */
export const LOOPBACK_HANDSHAKE_TIMEOUT_MS = 30_000;
export const getHandshakeTimeoutMs = (opts?: { isLoopback?: boolean }) => {
  // User-facing env var (works in all environments); test-only var gated behind VITEST
  const envKey =
    process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS ||
    (process.env.VITEST && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
  if (envKey) {
    const parsed = Number(envKey);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return opts?.isLoopback ? LOOPBACK_HANDSHAKE_TIMEOUT_MS : DEFAULT_HANDSHAKE_TIMEOUT_MS;
};
export const TICK_INTERVAL_MS = 30_000;
export const HEALTH_REFRESH_INTERVAL_MS = 60_000;
export const DEDUPE_TTL_MS = 5 * 60_000;
export const DEDUPE_MAX = 1000;
