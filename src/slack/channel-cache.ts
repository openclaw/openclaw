import type { WebClient } from "@slack/web-api";
import { createSlackWebClient } from "./client.js";

export type CachedSlackChannel = {
  id: string;
  name: string;
  archived: boolean;
  isPrivate: boolean;
};

type CacheEntry<T> = {
  data: T;
  timestamp: number;
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * SlackChannelCache - In-memory cache for Slack channel listings
 * Provides name → ID resolution with automatic expiration
 */
class SlackChannelCache {
  private cache: Map<string, CacheEntry<CachedSlackChannel[]>> = new Map();
  private lastRefresh: Map<string, number> = new Map();

  /**
   * Get cached channels for an account, refreshing if needed
   */
  async getChannels(token: string, client?: WebClient): Promise<CachedSlackChannel[]> {
    const key = this.getAccountKey(token);
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const slackClient = client ?? createSlackWebClient(token);
    const channels = await this.fetchChannels(slackClient);
    this.cache.set(key, { data: channels, timestamp: now });
    this.lastRefresh.set(key, now);

    return channels;
  }

  /**
   * Resolve a channel name or ID to channel info
   */
  async resolveChannel(
    token: string,
    input: string,
    client?: WebClient,
  ): Promise<CachedSlackChannel | undefined> {
    const channels = await this.getChannels(token, client);
    const normalized = this.normalizeInput(input);

    // Try exact ID match first
    if (normalized.id) {
      return channels.find((c) => c.id === normalized.id);
    }

    // Try name match (prefer non-archived)
    if (normalized.name) {
      const target = normalized.name.toLowerCase();
      const matches = channels.filter((c) => c.name.toLowerCase() === target);
      if (matches.length === 0) {
        return undefined;
      }
      // Prefer non-archived channel
      const active = matches.find((c) => !c.archived);
      return active ?? matches[0];
    }

    return undefined;
  }

  /**
   * Get all channels by name (convenient lookup)
   */
  async getChannelsByName(
    token: string,
    client?: WebClient,
  ): Promise<Map<string, CachedSlackChannel>> {
    const channels = await this.getChannels(token, client);
    const map = new Map<string, CachedSlackChannel>();
    for (const channel of channels) {
      map.set(channel.name.toLowerCase(), channel);
    }
    return map;
  }

  /**
   * Clear cache for a specific account (or all if no token provided)
   */
  clearCache(token?: string): void {
    if (token) {
      const key = this.getAccountKey(token);
      this.cache.delete(key);
      this.lastRefresh.delete(key);
    } else {
      this.cache.clear();
      this.lastRefresh.clear();
    }
  }

  /**
   * Get cache stats for monitoring
   */
  getStats(): { size: number; tokens: number; oldestEntryAge: number } {
    const now = Date.now();
    const ages = Array.from(this.lastRefresh.values()).map((ts) => now - ts);
    return {
      size: this.cache.size,
      tokens: this.lastRefresh.size,
      oldestEntryAge: ages.length > 0 ? Math.max(...ages) : 0,
    };
  }

  // ============ Private methods ============

  private getAccountKey(token: string): string {
    // Use first 16 chars of token as key (safe identifier)
    return token.slice(0, 16);
  }

  private normalizeInput(input: string): {
    id?: string;
    name?: string;
  } {
    const trimmed = input.trim();

    // Handle Slack mentions: <#C123456|channel-name>
    const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
    if (mention) {
      return {
        id: mention[1]?.toUpperCase(),
        name: mention[2]?.trim(),
      };
    }

    // Handle prefixed IDs: slack:C123456, channel:C123456
    const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
    if (/^[CG][A-Z0-9]+$/i.test(prefixed)) {
      return { id: prefixed.toUpperCase() };
    }

    // Handle channel names: #channel-name or just channel-name
    const name = prefixed.replace(/^#/, "").trim();
    return name ? { name } : {};
  }

  private async fetchChannels(client: WebClient): Promise<CachedSlackChannel[]> {
    const channels: CachedSlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const res = (await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: false,
        limit: 1000,
        cursor,
      })) as {
        channels?: Array<{
          id?: string;
          name?: string;
          is_archived?: boolean;
          is_private?: boolean;
        }>;
        response_metadata?: { next_cursor?: string };
      };

      for (const channel of res.channels ?? []) {
        const id = channel.id?.trim();
        const name = channel.name?.trim();
        if (!id || !name) {
          continue;
        }
        channels.push({
          id,
          name,
          archived: Boolean(channel.is_archived),
          isPrivate: Boolean(channel.is_private),
        });
      }

      const next = res.response_metadata?.next_cursor?.trim();
      cursor = next ? next : undefined;
    } while (cursor);

    return channels;
  }
}

// Global singleton instance
export const slackChannelCache = new SlackChannelCache();
