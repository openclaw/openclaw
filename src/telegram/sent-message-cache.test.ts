import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSentMessageCache, recordSentMessage, wasSentByBot } from "./sent-message-cache.js";

describe("sent-message-cache", () => {
  afterEach(() => {
    clearSentMessageCache();
  });

  it("records and retrieves a sent message", () => {
    recordSentMessage(123, 42);
    expect(wasSentByBot(123, 42)).toBe(true);
  });

  it("returns false for unrecorded messages", () => {
    expect(wasSentByBot(123, 42)).toBe(false);
  });

  it("returns false for wrong chat id", () => {
    recordSentMessage(123, 42);
    expect(wasSentByBot(456, 42)).toBe(false);
  });

  it("returns false for wrong message id", () => {
    recordSentMessage(123, 42);
    expect(wasSentByBot(123, 99)).toBe(false);
  });

  it("handles string and number chat ids consistently", () => {
    recordSentMessage(123, 42);
    expect(wasSentByBot("123", 42)).toBe(true);

    recordSentMessage("-1001234567890", 55);
    expect(wasSentByBot(-1001234567890, 55)).toBe(true);
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    try {
      recordSentMessage(123, 42);
      expect(wasSentByBot(123, 42)).toBe(true);

      // Advance past 24h TTL
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      expect(wasSentByBot(123, 42)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears all entries", () => {
    recordSentMessage(123, 42);
    recordSentMessage(456, 99);
    clearSentMessageCache();

    expect(wasSentByBot(123, 42)).toBe(false);
    expect(wasSentByBot(456, 99)).toBe(false);
  });
});
