import { describe, expect, it } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";

describe("SentMessageCache", () => {
  it("remembers and retrieves sent messages", () => {
    const cache = createSentMessageCache();
    cache.remember("scope1", { text: "hello", messageId: "msg-1" });
    expect(cache.has("scope1", { text: "hello" })).toBe(true);
    expect(cache.has("scope1", { messageId: "msg-1" })).toBe(true);
    expect(cache.has("scope1", { text: "unknown" })).toBe(false);
  });

  it("does not exceed hard cache cap", () => {
    const cache = createSentMessageCache();
    // Insert more than MAX_CACHE_ENTRIES (500) entries
    for (let i = 0; i < 600; i++) {
      cache.remember("scope", { messageId: `msg-${i}` });
    }
    // The oldest entries should have been evicted; recent ones should remain
    expect(cache.has("scope", { messageId: "msg-599" })).toBe(true);
    // msg-0 through msg-99 should have been evicted (600 - 500 = 100 excess)
    expect(cache.has("scope", { messageId: "msg-0" })).toBe(false);
  });
});
