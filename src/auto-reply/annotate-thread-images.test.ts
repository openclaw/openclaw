import { describe, expect, it } from "vitest";
import { buildImageAnnotation, normalizeTimestamp } from "./annotate-thread-images.js";

describe("normalizeTimestamp", () => {
  it("parses Slack-style decimal-seconds string", () => {
    const date = normalizeTimestamp("1710590400.123456");
    expect(date).toBeInstanceOf(Date);
    // 1710590400 seconds = Sat Mar 16 2024 12:00:00 UTC
    expect(date!.getUTCFullYear()).toBe(2024);
  });

  it("parses Unix seconds integer", () => {
    const date = normalizeTimestamp(1710590400);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCFullYear()).toBe(2024);
  });

  it("parses Unix milliseconds integer", () => {
    const date = normalizeTimestamp(1710590400000);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCFullYear()).toBe(2024);
  });

  it("parses ISO 8601 string", () => {
    const date = normalizeTimestamp("2026-03-16T10:50:00.000Z");
    expect(date).toBeInstanceOf(Date);
    expect(date!.getUTCFullYear()).toBe(2026);
  });

  it("returns null for undefined", () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeTimestamp(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeTimestamp("")).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(normalizeTimestamp(NaN)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(normalizeTimestamp(Infinity)).toBeNull();
  });
});

describe("buildImageAnnotation", () => {
  it("formats Slack-style decimal string timestamp correctly", () => {
    const result = buildImageAnnotation({
      totalMessages: 8,
      messageIndex: 1,
      timestamp: "1710590400.123456",
      author: "alice (user)",
      timezone: "America/New_York",
    });
    expect(result).toMatch(/^\[Image — sent .+\]$/);
    expect(result).toContain("message 1 of 8 in thread");
    expect(result).toContain("from alice (user)");
    // Should contain a formatted date, not "unknown time"
    expect(result).not.toContain("unknown time");
  });

  it("handles missing timestamp gracefully", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
      timestamp: undefined,
    });
    expect(result).toContain("unknown time");
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("NaN");
    expect(result).toContain("message 2 of 3 in thread");
  });

  it("omits author clause when author is absent", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
      timestamp: "1710590400",
    });
    expect(result).not.toContain("from");
  });

  it("omits author clause when author is empty string", () => {
    const result = buildImageAnnotation({
      totalMessages: 3,
      messageIndex: 2,
      timestamp: "1710590400",
      author: "  ",
    });
    expect(result).not.toContain("from");
  });

  it('shows "standalone message" for single-message threads', () => {
    const result = buildImageAnnotation({
      totalMessages: 1,
      messageIndex: 1,
      timestamp: "1710590400",
      author: "bob",
    });
    expect(result).toContain("standalone message");
    expect(result).not.toContain("of 1 in thread");
  });

  it("handles Unix seconds integer timestamp", () => {
    const result = buildImageAnnotation({
      totalMessages: 5,
      messageIndex: 3,
      timestamp: 1710590400,
    });
    expect(result).not.toContain("unknown time");
    expect(result).toContain("message 3 of 5 in thread");
  });

  it("handles ISO string timestamp", () => {
    const result = buildImageAnnotation({
      totalMessages: 4,
      messageIndex: 2,
      timestamp: "2026-03-16T10:50:00.000Z",
      timezone: "UTC",
    });
    expect(result).not.toContain("unknown time");
    expect(result).toContain("message 2 of 4 in thread");
  });

  it("defaults to UTC when timezone is not provided", () => {
    const result = buildImageAnnotation({
      totalMessages: 2,
      messageIndex: 1,
      timestamp: 1710590400,
    });
    expect(result).toContain("UTC");
  });

  it("falls back to UTC for invalid timezone", () => {
    const result = buildImageAnnotation({
      totalMessages: 2,
      messageIndex: 1,
      timestamp: 1710590400,
      timezone: "Invalid/Timezone",
    });
    // Should not crash, should fall back to UTC
    expect(result).not.toContain("unknown time");
  });
});
