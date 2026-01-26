/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  messageIds: Set<number>;
  timestamps: Map<number, number>;
  lastSent?: { messageId: number; timestamp: number; isStatus: boolean };
};

const sentMessages = new Map<string, CacheEntry>();

function getChatKey(chatId: number | string): string {
  return String(chatId);
}

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, timestamp] of entry.timestamps) {
    if (now - timestamp > TTL_MS) {
      entry.messageIds.delete(msgId);
      entry.timestamps.delete(msgId);
    }
  }
}

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  isStatus: boolean = false,
): void {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { messageIds: new Set(), timestamps: new Map() };
    sentMessages.set(key, entry);
  }
  const now = Date.now();
  entry.messageIds.add(messageId);
  entry.timestamps.set(messageId, now);
  entry.lastSent = { messageId, timestamp: now, isStatus };
  // Periodic cleanup
  if (entry.messageIds.size > 100) {
    cleanupExpired(entry);
  }
}

/**
 * Invalidate the "status" flag of the last sent message.
 * This prevents subsequent messages from overwriting it.
 */
export function invalidateLastStatus(chatId: number | string): void {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (entry?.lastSent) {
    entry.lastSent.isStatus = false;
  }
}

/**
 * Get the last sent message ID and timestamp for a chat.
 */
export function getLastSentMessage(
  chatId: number | string,
): { messageId: number; timestamp: number; isStatus: boolean } | undefined {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  return entry?.lastSent;
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) return false;
  // Clean up expired entries on read
  cleanupExpired(entry);
  return entry.messageIds.has(messageId);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
