/**
 * Message idempotency store for deduplication.
 *
 * Prevents duplicate message processing by tracking message IDs
 * with automatic expiration.
 */

export interface IdempotencyStore {
  /** Check if key exists (message already processed) */
  has(key: string): Promise<boolean>;
  /** Mark key as processed with TTL */
  set(key: string, ttlMs: number): Promise<void>;
  /** Remove key (for cleanup on failure) */
  delete(key: string): Promise<void>;
  /** Get current store size */
  size(): number;
  /** Clear expired entries */
  prune(): void;
}

interface StoreEntry {
  expiresAt: number;
}

/**
 * Build a unique idempotency key from channel and message ID.
 */
export function buildIdempotencyKey(channel: string, messageId: string): string {
  return `${channel}:${messageId}`;
}

/**
 * Create an in-memory idempotency store with automatic expiration.
 *
 * @param maxSize - Maximum entries before forced pruning (default 10000)
 * @param pruneIntervalMs - Interval for automatic pruning (default 60000)
 */
export function createInMemoryIdempotencyStore(
  maxSize = 10000,
  pruneIntervalMs = 60000,
): IdempotencyStore {
  const store = new Map<string, StoreEntry>();
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  };

  // Start automatic pruning
  if (pruneIntervalMs > 0) {
    pruneTimer = setInterval(prune, pruneIntervalMs);
    // Allow process to exit even with timer running (Node.js only)
    const timer = pruneTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  return {
    async has(key: string): Promise<boolean> {
      const entry = store.get(key);
      if (!entry) {
        return false;
      }
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return false;
      }
      return true;
    },

    async set(key: string, ttlMs: number): Promise<void> {
      // Force prune if at max capacity
      if (store.size >= maxSize) {
        prune();
      }
      store.set(key, { expiresAt: Date.now() + ttlMs });
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    size(): number {
      return store.size;
    },

    prune,
  };
}

/** Default TTL for idempotency keys (5 minutes) */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/** Short TTL for high-frequency operations (1 minute) */
export const SHORT_IDEMPOTENCY_TTL_MS = 60 * 1000;

/** Long TTL for critical operations (30 minutes) */
export const LONG_IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

/**
 * Wrapper to execute a function only if the key is not already processed.
 *
 * @param store - Idempotency store
 * @param key - Unique key for this operation
 * @param fn - Function to execute
 * @param ttlMs - TTL for the idempotency key
 * @returns Result of fn, or null if already processed
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  fn: () => Promise<T>,
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
): Promise<{ executed: boolean; result?: T }> {
  if (await store.has(key)) {
    return { executed: false };
  }

  // Mark as processing before execution
  await store.set(key, ttlMs);

  try {
    const result = await fn();
    return { executed: true, result };
  } catch (err) {
    // Remove key on failure so retry is possible
    await store.delete(key);
    throw err;
  }
}
