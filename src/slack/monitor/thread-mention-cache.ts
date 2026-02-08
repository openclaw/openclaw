/**
 * Bounded FIFO cache that tracks threads where the bot was explicitly mentioned
 * in the root message. Used to enable implicit-mention (auto-follow) for
 * subsequent thread replies so users don't have to re-mention the bot.
 *
 * Entries expire after {@link THREAD_MENTION_TTL_MS} and the map is capped
 * at {@link THREAD_MENTION_MAX_ENTRIES} (evicting oldest-first) to prevent
 * unbounded growth.
 */

const THREAD_MENTION_MAX_ENTRIES = 1000;
const THREAD_MENTION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  /** Timestamp (Date.now()) when the entry was recorded. */
  createdAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/** Evict the oldest (FIFO) entries when the cache exceeds the max size. */
function evictIfNeeded(): void {
  if (cache.size <= THREAD_MENTION_MAX_ENTRIES) {
    return;
  }
  // Map iteration order is insertion order – delete the first (oldest) entries.
  const toRemove = cache.size - THREAD_MENTION_MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= toRemove) {
      break;
    }
    cache.delete(key);
    removed++;
  }
}

/**
 * Record that the bot was explicitly mentioned in a root-level channel message.
 * Call this when `wasMentioned` is true and the message is *not* a thread reply.
 */
export function recordThreadMention(channelId: string, messageTs: string): void {
  const key = cacheKey(channelId, messageTs);
  cache.set(key, { createdAt: Date.now() });
  evictIfNeeded();
}

/**
 * Check whether the bot was mentioned in the root message of a thread.
 * Returns `true` if the root was recorded and the entry hasn't expired.
 */
export function wasThreadRootMentioned(channelId: string, threadTs: string): boolean {
  const key = cacheKey(channelId, threadTs);
  const entry = cache.get(key);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.createdAt > THREAD_MENTION_TTL_MS) {
    cache.delete(key);
    return false;
  }
  return true;
}

/**
 * Visible for testing – clear all entries.
 */
export function _clearThreadMentionCache(): void {
  cache.clear();
}
