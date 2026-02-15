/**
 * Slack Channel Name Resolution Cache
 *
 * Provides a TTL-based in-memory cache for Slack channel name ↔ ID lookups
 * to minimize API calls and respect rate limits. The cache supports both
 * forward (name → ID) and reverse (ID → name) lookups.
 */

import type { SlackChannelLookup } from "./resolve-channels.js";

export type ChannelCacheEntry = SlackChannelLookup & {
  cachedAt: number;
};

export type ChannelCacheOptions = {
  /** TTL in milliseconds. Default: 5 minutes */
  ttlMs?: number;
  /** Maximum entries to cache. Default: 10000 */
  maxEntries?: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class SlackChannelCache {
  private byId = new Map<string, ChannelCacheEntry>();
  private byName = new Map<string, ChannelCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options?: ChannelCacheOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Cache a channel lookup result. */
  set(channel: SlackChannelLookup): void {
    if (!channel.id || !channel.name) {
      return;
    }

    // Evict if at capacity
    if (this.byId.size >= this.maxEntries && !this.byId.has(channel.id)) {
      this.evictOldest();
    }

    const entry: ChannelCacheEntry = { ...channel, cachedAt: Date.now() };
    this.byId.set(channel.id, entry);
    this.byName.set(channel.name.toLowerCase(), entry);
  }

  /** Bulk-load channels into the cache. */
  setMany(channels: SlackChannelLookup[]): void {
    for (const ch of channels) {
      this.set(ch);
    }
  }

  /** Look up a channel by its Slack ID. Returns undefined if not cached or expired. */
  getById(id: string): ChannelCacheEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.delete(entry);
      return undefined;
    }
    return entry;
  }

  /** Look up a channel by name (case-insensitive). Returns undefined if not cached or expired. */
  getByName(name: string): ChannelCacheEntry | undefined {
    const entry = this.byName.get(name.toLowerCase());
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.delete(entry);
      return undefined;
    }
    return entry;
  }

  /** Invalidate a specific channel entry. */
  invalidate(idOrName: string): void {
    const byId = this.byId.get(idOrName);
    if (byId) {
      this.delete(byId);
      return;
    }
    const byName = this.byName.get(idOrName.toLowerCase());
    if (byName) {
      this.delete(byName);
    }
  }

  /** Clear all cached entries. */
  clear(): void {
    this.byId.clear();
    this.byName.clear();
  }

  /** Return the number of cached entries. */
  get size(): number {
    return this.byId.size;
  }

  /** Prune all expired entries. Returns the number of entries removed. */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [, entry] of this.byId) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.delete(entry);
        removed++;
      }
    }
    return removed;
  }

  private isExpired(entry: ChannelCacheEntry): boolean {
    return Date.now() - entry.cachedAt > this.ttlMs;
  }

  private delete(entry: ChannelCacheEntry): void {
    this.byId.delete(entry.id);
    this.byName.delete(entry.name.toLowerCase());
  }

  private evictOldest(): void {
    let oldest: ChannelCacheEntry | undefined;
    for (const [, entry] of this.byId) {
      if (!oldest || entry.cachedAt < oldest.cachedAt) {
        oldest = entry;
      }
    }
    if (oldest) {
      this.delete(oldest);
    }
  }
}

// Singleton instance per workspace
let defaultCache: SlackChannelCache | undefined;

/** Get the shared default channel cache instance. */
export function getDefaultChannelCache(): SlackChannelCache {
  if (!defaultCache) {
    defaultCache = new SlackChannelCache();
  }
  return defaultCache;
}

/** Reset the default cache (useful for testing). */
export function resetDefaultChannelCache(): void {
  defaultCache?.clear();
  defaultCache = undefined;
}
