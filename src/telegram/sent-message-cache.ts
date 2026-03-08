/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  timestamps: Map<number, number>;
};

const sentMessages = new Map<string, CacheEntry>();

function getChatKey(chatId: number | string): string {
  return String(chatId);
}

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.timestamps.delete(msgId);
    }
  }
}

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(chatId: number | string, messageId: number): void {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { timestamps: new Map() };
    sentMessages.set(key, entry);
  }
  entry.timestamps.set(messageId, Date.now());
  // Periodic cleanup
  if (entry.timestamps.size > 100) {
    cleanupExpired(entry);
  }
}

/**
 * Check if a message was sent by the bot.
 *
 * Returns:
 *   true  — message is in cache (bot sent it)
 *   false — chat is tracked but this message ID is not present (user sent it)
 *   null  — no cache entry for this chat at all (restart / TTL expiry / never seen)
 *
 * Callers should treat `null` as "unknown" and apply context-appropriate defaults.
 * In DMs, unknown should default to forwarding (bot is always the counterpart).
 * In groups, unknown should default to skipping (conservative).
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean | null {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return null; // no data for this chat — cache miss
  }
  // Clean up expired entries on read
  cleanupExpired(entry);
  if (!entry.timestamps.has(messageId)) {
    if (entry.timestamps.size === 0) {
      return null; // all entries expired — treat as cache miss
    }
    return false; // chat is tracked, this message is not bot-sent
  }
  return true;
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
