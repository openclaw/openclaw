import type { WebClient } from "@slack/web-api";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { slackChannelCache } from "./channel-cache.js";

describe("SlackChannelCache", () => {
  const mockToken = "xoxb-test-token-123456";
  const mockChannels = [
    { id: "C001", name: "general", is_archived: false, is_private: false },
    { id: "C002", name: "random", is_archived: false, is_private: false },
    { id: "C003", name: "archived-chan", is_archived: true, is_private: false },
    { id: "C004", name: "private-chan", is_archived: false, is_private: true },
  ];

  let mockClient: Partial<WebClient>;

  beforeEach(() => {
    slackChannelCache.clearCache();
    mockClient = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: mockChannels,
          response_metadata: { next_cursor: "" },
        }),
      },
    };
  });

  describe("getChannels", () => {
    it("should fetch channels from Slack API", async () => {
      const channels = await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      expect(channels).toHaveLength(4);
      expect(channels[0]).toEqual({
        id: "C001",
        name: "general",
        archived: false,
        isPrivate: false,
      });
    });

    it("should cache channels and not refetch within TTL", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const spy = vi.spyOn(mockClient.conversations!, "list");

      // Second call should use cache
      const channels = await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      expect(channels).toHaveLength(4);
      expect(spy).not.toHaveBeenCalled();
    });

    it("should handle pagination", async () => {
      const paginatedClient = {
        conversations: {
          list: vi
            .fn()
            .mockResolvedValueOnce({
              channels: mockChannels.slice(0, 2),
              response_metadata: { next_cursor: "cursor123" },
            })
            .mockResolvedValueOnce({
              channels: mockChannels.slice(2),
              response_metadata: { next_cursor: "" },
            }),
        },
      };

      const channels = await slackChannelCache.getChannels(mockToken, paginatedClient as any);
      expect(channels).toHaveLength(4);
    });
  });

  describe("resolveChannel", () => {
    beforeEach(async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
    });

    it("should resolve channel by ID", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "C001",
        mockClient as WebClient,
      );
      expect(channel?.name).toBe("general");
    });

    it("should resolve channel by name", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "random",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C002");
    });

    it("should handle case-insensitive name matching", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "GENERAL",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C001");
    });

    it("should prefer non-archived channels", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "archived-chan",
        mockClient as WebClient,
      );
      expect(channel?.name).toBe("archived-chan");
      expect(channel?.archived).toBe(true);
    });

    it("should handle Slack mentions", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "<#C002|random>",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C002");
    });

    it("should handle # prefix", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "#general",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C001");
    });

    it("should return undefined for unknown channel", async () => {
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "unknown",
        mockClient as WebClient,
      );
      expect(channel).toBeUndefined();
    });
  });

  describe("getChannelsByName", () => {
    it("should return map of channels by lowercase name", async () => {
      const map = await slackChannelCache.getChannelsByName(mockToken, mockClient as WebClient);
      expect(map.get("general")?.id).toBe("C001");
      expect(map.get("random")?.id).toBe("C002");
      expect(map.size).toBe(4);
    });
  });

  describe("clearCache", () => {
    it("should clear cache for specific token", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      slackChannelCache.clearCache(mockToken);

      const spy = vi.spyOn(mockClient.conversations!, "list");
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      expect(spy).toHaveBeenCalled();
    });

    it("should clear all caches when no token provided", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      slackChannelCache.clearCache();

      const spy = vi.spyOn(mockClient.conversations!, "list");
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      expect(spy).toHaveBeenCalled();
    });
  });

  describe("getStats", () => {
    it("should return cache statistics", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const stats = slackChannelCache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.tokens).toBe(1);
      expect(stats.oldestEntryAge).toBeGreaterThanOrEqual(0);
    });
  });
});
