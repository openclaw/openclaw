export type StickyThreadTracker = {
  record: (channelId: string, threadTs: string) => void;
  isActive: (channelId: string, threadTs: string) => boolean;
  size: () => number;
  clear: () => void;
};

export function createStickyThreadTracker(opts?: {
  ttlMs?: number;
  maxSize?: number;
}): StickyThreadTracker {
  const ttlMs = Math.max(0, opts?.ttlMs ?? 24 * 60 * 60 * 1000);
  const maxSize = Math.max(0, Math.floor(opts?.maxSize ?? 10_000));
  const cache = new Map<string, number>();

  const makeKey = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;

  const prune = (now: number) => {
    if (ttlMs > 0) {
      const cutoff = now - ttlMs;
      for (const [key, ts] of cache) {
        if (ts < cutoff) {
          cache.delete(key);
        }
      }
    }
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  return {
    record: (channelId, threadTs) => {
      const key = makeKey(channelId, threadTs);
      const now = Date.now();
      cache.set(key, now);
      prune(now);
    },
    isActive: (channelId, threadTs) => {
      const key = makeKey(channelId, threadTs);
      const ts = cache.get(key);
      if (ts === undefined) {
        return false;
      }
      if (ttlMs > 0 && Date.now() - ts >= ttlMs) {
        cache.delete(key);
        return false;
      }
      return true;
    },
    size: () => cache.size,
    clear: () => {
      cache.clear();
    },
  };
}
