import { afterEach, describe, expect, it } from "vitest";
import {
  cacheTopicName,
  clearTopicCache,
  getCachedTopicName,
  getTopicCacheSize,
  slugifyTopicName,
} from "./topic-cache.js";

describe("topic-cache", () => {
  afterEach(() => {
    clearTopicCache();
  });

  describe("cacheTopicName", () => {
    it("stores topic name by chat and topic ID", () => {
      cacheTopicName(-1003856094222, 49, "Telegram Ops");
      expect(getCachedTopicName(-1003856094222, 49)).toBe("Telegram Ops");
    });

    it("accepts string chat IDs", () => {
      cacheTopicName("-1003856094222", 49, "Telegram Ops");
      expect(getCachedTopicName("-1003856094222", 49)).toBe("Telegram Ops");
    });

    it("overwrites existing entries", () => {
      cacheTopicName(-100123, 1, "Original Name");
      cacheTopicName(-100123, 1, "Updated Name");
      expect(getCachedTopicName(-100123, 1)).toBe("Updated Name");
    });

    it("stores multiple topics for the same chat", () => {
      cacheTopicName(-100123, 1, "General");
      cacheTopicName(-100123, 2, "Random");
      cacheTopicName(-100123, 3, "Announcements");

      expect(getCachedTopicName(-100123, 1)).toBe("General");
      expect(getCachedTopicName(-100123, 2)).toBe("Random");
      expect(getCachedTopicName(-100123, 3)).toBe("Announcements");
    });

    it("stores topics across different chats", () => {
      cacheTopicName(-100123, 1, "Chat A Topic");
      cacheTopicName(-100456, 1, "Chat B Topic");

      expect(getCachedTopicName(-100123, 1)).toBe("Chat A Topic");
      expect(getCachedTopicName(-100456, 1)).toBe("Chat B Topic");
    });
  });

  describe("getCachedTopicName", () => {
    it("returns undefined for unknown topics", () => {
      expect(getCachedTopicName(-100123, 99)).toBeUndefined();
    });

    it("returns undefined for unknown chats", () => {
      cacheTopicName(-100123, 1, "Known Topic");
      expect(getCachedTopicName(-100999, 1)).toBeUndefined();
    });

    it("returns cached name after caching", () => {
      cacheTopicName(-100123, 42, "My Topic");
      expect(getCachedTopicName(-100123, 42)).toBe("My Topic");
    });

    it("handles numeric string chat ID matching", () => {
      cacheTopicName(-100123, 1, "Test");
      // String and number should use the same cache key format
      expect(getCachedTopicName("-100123", 1)).toBe("Test");
    });
  });

  describe("slugifyTopicName", () => {
    it("converts to lowercase", () => {
      expect(slugifyTopicName("UPPERCASE")).toBe("uppercase");
      expect(slugifyTopicName("MixedCase")).toBe("mixedcase");
    });

    it("replaces spaces with dashes", () => {
      expect(slugifyTopicName("hello world")).toBe("hello-world");
      expect(slugifyTopicName("multiple   spaces")).toBe("multiple-spaces");
    });

    it("replaces underscores with dashes", () => {
      expect(slugifyTopicName("hello_world")).toBe("hello-world");
      expect(slugifyTopicName("multiple___underscores")).toBe("multiple-underscores");
    });

    it("removes special characters", () => {
      expect(slugifyTopicName("hello!")).toBe("hello");
      expect(slugifyTopicName("test@#$%")).toBe("test");
      expect(slugifyTopicName("what's up?")).toBe("whats-up");
    });

    it("preserves numbers", () => {
      expect(slugifyTopicName("test123")).toBe("test123");
      expect(slugifyTopicName("topic 42")).toBe("topic-42");
    });

    it("collapses multiple dashes", () => {
      expect(slugifyTopicName("hello---world")).toBe("hello-world");
      expect(slugifyTopicName("a - b - c")).toBe("a-b-c");
    });

    it("trims leading and trailing dashes", () => {
      expect(slugifyTopicName("-hello-")).toBe("hello");
      expect(slugifyTopicName("---test---")).toBe("test");
      expect(slugifyTopicName("  spaced  ")).toBe("spaced");
    });

    it("handles emoji and unicode", () => {
      expect(slugifyTopicName("🎉 Party")).toBe("party");
      expect(slugifyTopicName("Café Discussion")).toBe("caf-discussion");
    });

    it("truncates long names to max 50 characters", () => {
      const longName =
        "this is a very long topic name that should be truncated to fit within the limit";
      const result = slugifyTopicName(longName);
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result.endsWith("-")).toBe(false);
    });

    it("truncates at word boundary when possible", () => {
      // 51+ chars: "this-is-a-really-long-topic-name-that-exceeds-limit-x"
      const longName = "this is a really long topic name that exceeds limit x";
      const result = slugifyTopicName(longName);
      expect(result.length).toBeLessThanOrEqual(50);
      // Should end at a word boundary (no partial words)
      expect(result.endsWith("-")).toBe(false);
    });

    it("handles real-world topic names", () => {
      expect(slugifyTopicName("Telegram Ops")).toBe("telegram-ops");
      expect(slugifyTopicName("General Discussion")).toBe("general-discussion");
      expect(slugifyTopicName("🔔 Announcements")).toBe("announcements");
      expect(slugifyTopicName("Q&A / Support")).toBe("qa-support");
      expect(slugifyTopicName("Off-Topic Chat")).toBe("off-topic-chat");
    });

    it("returns empty string for names with only special characters", () => {
      expect(slugifyTopicName("🎉🎊🎁")).toBe("");
      expect(slugifyTopicName("!!!")).toBe("");
      expect(slugifyTopicName("   ")).toBe("");
    });
  });

  describe("clearTopicCache", () => {
    it("removes all cached entries", () => {
      cacheTopicName(-100123, 1, "Topic A");
      cacheTopicName(-100123, 2, "Topic B");
      cacheTopicName(-100456, 1, "Topic C");

      expect(getTopicCacheSize()).toBe(3);

      clearTopicCache();

      expect(getTopicCacheSize()).toBe(0);
      expect(getCachedTopicName(-100123, 1)).toBeUndefined();
      expect(getCachedTopicName(-100123, 2)).toBeUndefined();
      expect(getCachedTopicName(-100456, 1)).toBeUndefined();
    });
  });

  describe("getTopicCacheSize", () => {
    it("returns 0 when cache is empty", () => {
      expect(getTopicCacheSize()).toBe(0);
    });

    it("returns correct count after adding entries", () => {
      cacheTopicName(-100123, 1, "Topic 1");
      expect(getTopicCacheSize()).toBe(1);

      cacheTopicName(-100123, 2, "Topic 2");
      expect(getTopicCacheSize()).toBe(2);

      cacheTopicName(-100456, 1, "Topic 3");
      expect(getTopicCacheSize()).toBe(3);
    });

    it("does not double-count updates to existing entries", () => {
      cacheTopicName(-100123, 1, "Original");
      cacheTopicName(-100123, 1, "Updated");
      expect(getTopicCacheSize()).toBe(1);
    });
  });
});
