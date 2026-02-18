/**
 * Optimized Config Access Utilities
 * Demonstrates how to use memoization and LRU cache for performance optimization
 */

import { memoize, memoizeAsync } from "../infra/memoize.js";
import { LRUCache } from "../infra/lru-cache.js";
import type { OpenClawConfig } from "../config/config.js";

export const getCachedModelCatalog = memoizeAsync(
  async (config: OpenClawConfig) => {
    const { loadModelCatalog } = await import("../agents/model-catalog.js");
    return loadModelCatalog({ config, useCache: true });
  },
  { ttlMs: 300_000, maxSize: 5 },
);

export const getCachedChannelCapabilities = memoize(
  (channelId: string, config: OpenClawConfig) => {
    const channel = config.channels?.[channelId];
    if (!channel) {
      return null;
    }
    return {
      supportsMedia: channel.media !== false,
      supportsMarkdown: true,
      maxMessageLength: channel.maxMessageLength ?? 4096,
    };
  },
  { ttlMs: 60_000, maxSize: 100 },
);

export const getCachedAgentDefaults = memoize(
  (_agentId: string, _config: OpenClawConfig) => {
    return _config.agents?.defaults;
  },
  { ttlMs: 300_000, maxSize: 50 },
);

export const messageDedupeCache = new LRUCache<{
  timestamp: number;
  payload: unknown;
}>({ maxSize: 1000, ttlMs: 30_000 });

export function createMessageDedupeKey(channel: string, threadId?: string, content?: string): string {
  return threadId ? `${channel}:${threadId}:${content}` : `${channel}:${content}`;
}

export function isMessageDuplicate(
  channel: string,
  threadId: string | undefined,
  content: string,
): boolean {
  const key = createMessageDedupeKey(channel, threadId, content);
  const existing = messageDedupeCache.get(key);
  if (existing) {
    return true;
  }
  messageDedupeCache.set(key, { timestamp: Date.now(), payload: content });
  return false;
}
