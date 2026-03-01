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
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  // Clean up expired entries on read
  cleanupExpired(entry);
  return entry.timestamps.has(messageId);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
