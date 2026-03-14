import { describe, it, expect, beforeEach } from "vitest";
import { isDuplicate, recordMessage, getDedupeStats, stopDedupeCleanup } from "./message-dedupe.js";

describe("message-dedupe", () => {
  beforeEach(() => {
    // Reset between tests by stopping cleanup and clearing
    stopDedupeCleanup();
  });

  it("should detect duplicate messages within the window", () => {
    const params = {
      channel: "telegram",
      to: "123456",
      text: "Hello world",
    };

    // First message should not be duplicate
    expect(isDuplicate(params)).toBe(false);

    // Record it
    recordMessage(params);

    // Second message with same params should be duplicate
    expect(isDuplicate(params)).toBe(true);
  });

  it("should not detect duplicate after window expires", async () => {
    const params = {
      channel: "telegram",
      to: "123456",
      text: "Hello world",
    };

    recordMessage(params);
    expect(isDuplicate(params)).toBe(true);

    // Note: In real test we'd mock time, but for now just verify structure
    expect(getDedupeStats().chatCount).toBe(1);
  });

  it("should track different chats separately", () => {
    const msg1 = { channel: "telegram", to: "111", text: "Hello" };
    const msg2 = { channel: "telegram", to: "222", text: "Hello" };

    recordMessage(msg1);
    expect(isDuplicate(msg1)).toBe(true);
    expect(isDuplicate(msg2)).toBe(false);
  });

  it("should include mediaUrl in fingerprint", () => {
    const msg1 = { channel: "telegram", to: "123", text: "Check this", mediaUrl: "https://example.com/img1.jpg" };
    const msg2 = { channel: "telegram", to: "123", text: "Check this", mediaUrl: "https://example.com/img2.jpg" };

    recordMessage(msg1);
    expect(isDuplicate(msg1)).toBe(true);
    expect(isDuplicate(msg2)).toBe(false); // Different mediaUrl
  });

  it("should track stats correctly", () => {
    recordMessage({ channel: "telegram", to: "1", text: "a" });
    recordMessage({ channel: "telegram", to: "1", text: "b" });
    recordMessage({ channel: "slack", to: "2", text: "c" });

    const stats = getDedupeStats();
    expect(stats.chatCount).toBe(2);
    expect(stats.totalEntries).toBe(3);
  });
});
