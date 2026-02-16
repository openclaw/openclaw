/**
 * Topic Name Cache for Telegram Forum Topics
 *
 * Stores topic names from forum_topic_created and forum_topic_edited events
 * for use in building human-readable session keys.
 *
 * This is a simple in-memory cache that doesn't need persistence -
 * topic names are refreshed from service messages as they occur.
 */

const MAX_SLUG_LENGTH = 50;

/**
 * In-memory cache for topic names.
 * Key format: `${chatId}:${topicId}`
 * Value: topic name (original, not slugified)
 */
const topicNameCache = new Map<string, string>();

/**
 * Build the cache key for a topic.
 */
function buildCacheKey(chatId: number | string, topicId: number): string {
  return `${chatId}:${topicId}`;
}

/**
 * Cache a topic name for a given chat and topic ID.
 */
export function cacheTopicName(chatId: number | string, topicId: number, name: string): void {
  const key = buildCacheKey(chatId, topicId);
  topicNameCache.set(key, name);
}

/**
 * Retrieve a cached topic name for a given chat and topic ID.
 * Returns undefined if not cached.
 */
export function getCachedTopicName(chatId: number | string, topicId: number): string | undefined {
  const key = buildCacheKey(chatId, topicId);
  return topicNameCache.get(key);
}

/**
 * Convert a topic name to a URL-safe slug suitable for session keys.
 *
 * Rules:
 * - Lowercase
 * - Replace spaces and underscores with dashes
 * - Remove non-alphanumeric characters (except dashes)
 * - Collapse multiple dashes
 * - Trim leading/trailing dashes
 * - Truncate to MAX_SLUG_LENGTH characters
 *
 * Examples:
 * - "Telegram Ops" -> "telegram-ops"
 * - "General Discussion!" -> "general-discussion"
 * - "Test_Topic__123" -> "test-topic-123"
 */
export function slugifyTopicName(name: string): string {
  let slug = name
    .toLowerCase()
    // Replace spaces and underscores with dashes
    .replace(/[\s_]+/g, "-")
    // Remove non-alphanumeric characters except dashes
    .replace(/[^a-z0-9-]/g, "")
    // Collapse multiple dashes
    .replace(/-+/g, "-")
    // Trim leading/trailing dashes
    .replace(/^-+|-+$/g, "");

  // Truncate to max length, avoiding cutting in the middle of a word
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH);
    // If we cut in the middle, trim to the last dash
    const lastDash = slug.lastIndexOf("-");
    if (lastDash > MAX_SLUG_LENGTH / 2) {
      slug = slug.slice(0, lastDash);
    }
    // Trim trailing dash if truncation left one
    slug = slug.replace(/-+$/, "");
  }

  return slug;
}

/**
 * Clear all cached topic names (primarily for testing).
 */
export function clearTopicCache(): void {
  topicNameCache.clear();
}

/**
 * Get the number of cached topic names (primarily for testing/debugging).
 */
export function getTopicCacheSize(): number {
  return topicNameCache.size;
}
