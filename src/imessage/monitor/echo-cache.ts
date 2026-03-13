export type SentMessageLookup = {
  text?: string;
  messageId?: string;
};

export type SentMessageCache = {
  remember: (scope: string, lookup: SentMessageLookup) => void;
  has: (scope: string, lookup: SentMessageLookup) => boolean;
};

// Keep the text fallback short so repeated user replies like "ok" are not
// suppressed for long; delayed reflections should match the stronger message-id key.
const SENT_MESSAGE_TEXT_TTL_MS = 5_000;
const SENT_MESSAGE_ID_TTL_MS = 60_000;
/** Hard cap to prevent unbounded memory growth in long-running processes. */
const MAX_CACHE_ENTRIES = 1000;

function normalizeEchoTextKey(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function normalizeEchoMessageIdKey(messageId: string | undefined): string | null {
  if (!messageId) {
    return null;
  }
  const normalized = messageId.trim();
  if (!normalized || normalized === "ok" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

class DefaultSentMessageCache implements SentMessageCache {
  private textCache = new Map<string, number>();
  private messageIdCache = new Map<string, number>();

  remember(scope: string, lookup: SentMessageLookup): void {
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const cacheKey = `${scope}:${textKey}`;
      // Delete before re-setting so the key moves to the end of iteration order.
      // Map preserves insertion order; without this, re-set keys keep their
      // original position and the LRU eviction in evictOldest is incorrect.
      this.textCache.delete(cacheKey);
      this.textCache.set(cacheKey, Date.now());
    }
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const cacheKey = `${scope}:${messageIdKey}`;
      this.messageIdCache.delete(cacheKey);
      this.messageIdCache.set(cacheKey, Date.now());
    }
    this.cleanup();
  }

  has(scope: string, lookup: SentMessageLookup): boolean {
    this.cleanup();
    const messageIdKey = normalizeEchoMessageIdKey(lookup.messageId);
    if (messageIdKey) {
      const idTimestamp = this.messageIdCache.get(`${scope}:${messageIdKey}`);
      if (idTimestamp && Date.now() - idTimestamp <= SENT_MESSAGE_ID_TTL_MS) {
        return true;
      }
    }
    const textKey = normalizeEchoTextKey(lookup.text);
    if (textKey) {
      const textTimestamp = this.textCache.get(`${scope}:${textKey}`);
      if (textTimestamp && Date.now() - textTimestamp <= SENT_MESSAGE_TEXT_TTL_MS) {
        return true;
      }
    }
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.textCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_TEXT_TTL_MS) {
        this.textCache.delete(key);
      }
    }
    for (const [key, timestamp] of this.messageIdCache.entries()) {
      if (now - timestamp > SENT_MESSAGE_ID_TTL_MS) {
        this.messageIdCache.delete(key);
      }
    }
    // Hard cap: if caches exceed the limit after TTL cleanup, evict oldest entries
    this.evictOldest(this.textCache, MAX_CACHE_ENTRIES);
    this.evictOldest(this.messageIdCache, MAX_CACHE_ENTRIES);
  }

  private evictOldest(cache: Map<string, number>, max: number): void {
    if (cache.size <= max) {
      return;
    }
    // Map iteration order is insertion order; delete from the front
    const excess = cache.size - max;
    let removed = 0;
    for (const key of cache.keys()) {
      if (removed >= excess) {
        break;
      }
      cache.delete(key);
      removed++;
    }
  }
}

export function createSentMessageCache(): SentMessageCache {
  return new DefaultSentMessageCache();
}
