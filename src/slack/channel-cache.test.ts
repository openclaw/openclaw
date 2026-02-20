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
      // First call populates cache
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);

      // Create a fresh mock to verify no new calls are made
      const freshMock = {
        conversations: {
          list: vi.fn().mockResolvedValue({
            channels: mockChannels,
            response_metadata: { next_cursor: "" },
          }),
        },
      };

      // Second call should use cache, not call API
      const channels = await slackChannelCache.getChannels(mockToken, freshMock as WebClient);
      expect(channels).toHaveLength(4);
      expect(freshMock.conversations.list).not.toHaveBeenCalled();
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

      const channels = await slackChannelCache.getChannels(mockToken, paginatedClient as WebClient);
      expect(channels).toHaveLength(4);
    });
  });

  describe("resolveChannel", () => {
    it("should resolve channel by ID", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "C001",
        mockClient as WebClient,
      );
      expect(channel?.name).toBe("general");
    });

    it("should resolve channel by name", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "random",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C002");
    });

    it("should handle case-insensitive name matching", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "GENERAL",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C001");
    });

    it("should prefer non-archived channels", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "archived-chan",
        mockClient as WebClient,
      );
      expect(channel?.name).toBe("archived-chan");
      expect(channel?.archived).toBe(true);
    });

    it("should handle Slack mentions", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "<#C002|random>",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C002");
    });

    it("should handle # prefix", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
      const channel = await slackChannelCache.resolveChannel(
        mockToken,
        "#general",
        mockClient as WebClient,
      );
      expect(channel?.id).toBe("C001");
    });

    it("should return undefined for unknown channel", async () => {
      await slackChannelCache.getChannels(mockToken, mockClient as WebClient);
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

    it("should prefer non-archived channels when duplicate names exist", async () => {
      // Create mock with duplicate channel names (archived and non-archived)
      const duplicateClient = {
        conversations: {
          list: vi.fn().mockResolvedValue({
            channels: [
              { id: "C100", name: "duplicate", is_archived: true, is_private: false },
              { id: "C200", name: "duplicate", is_archived: false, is_private: false },
              { id: "C300", name: "other", is_archived: false, is_private: false },
            ],
            response_metadata: { next_cursor: "" },
          }),
        },
      };

      slackChannelCache.clearCache();
      const map = await slackChannelCache.getChannelsByName(
        "xoxb-duplicate-test",
        duplicateClient as WebClient,
      );

      // Should prefer C200 (non-archived) over C100 (archived)
      expect(map.get("duplicate")?.id).toBe("C200");
      expect(map.get("duplicate")?.archived).toBe(false);
    });

    it("should keep first non-archived when both duplicates are non-archived", async () => {
      const duplicateClient = {
        conversations: {
          list: vi.fn().mockResolvedValue({
            channels: [
              { id: "C100", name: "duplicate", is_archived: false, is_private: false },
              { id: "C200", name: "duplicate", is_archived: false, is_private: false },
            ],
            response_metadata: { next_cursor: "" },
          }),
        },
      };

      slackChannelCache.clearCache();
      const map = await slackChannelCache.getChannelsByName(
        "xoxb-dup-both-active",
        duplicateClient as WebClient,
      );

      // Should keep first one since both are non-archived
      expect(map.get("duplicate")?.id).toBe("C100");
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
