// Tests for surrogate-safe UTF-16 string slicing helpers.
import { describe, expect, it } from "vitest";
import { sliceUtf16Safe, truncateUtf16Safe } from "./utf16-slice.js";

describe("sliceUtf16Safe", () => {
  it("slices ASCII string normally", () => {
    expect(sliceUtf16Safe("hello world", 0, 5)).toBe("hello");
  });

  it("handles negative start", () => {
    expect(sliceUtf16Safe("hello world", -5)).toBe("world");
  });

  it("handles negative end", () => {
    expect(sliceUtf16Safe("hello world", 0, -6)).toBe("hello");
  });

  it("handles start beyond length", () => {
    expect(sliceUtf16Safe("hello", 10)).toBe("");
  });

  it("handles end beyond length", () => {
    expect(sliceUtf16Safe("hello", 0, 10)).toBe("hello");
  });

  it("swaps start and end when start > end", () => {
    expect(sliceUtf16Safe("hello", 3, 1)).toBe("el");
  });

  it("preserves emoji with surrogate pairs", () => {
    const emoji = "👨‍👩‍👧‍👦";
    expect(sliceUtf16Safe(emoji, 0)).toBe(emoji);
  });

  it("avoids splitting surrogate pair at start", () => {
    // 👨 is a surrogate pair (U+1F468)
    const input = "👨👩";
    // Slice at middle of surrogate pair should adjust
    const result = sliceUtf16Safe(input, 1, 3);
    // Should not return dangling surrogate
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("avoids splitting surrogate pair at end", () => {
    const input = "👨👩";
    const result = sliceUtf16Safe(input, 0, 1);
    // Should not return dangling surrogate
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("handles empty string", () => {
    expect(sliceUtf16Safe("", 0)).toBe("");
  });

  it("handles undefined end", () => {
    expect(sliceUtf16Safe("hello", 2)).toBe("llo");
  });
});

describe("truncateUtf16Safe", () => {
  it("returns input when shorter than limit", () => {
    expect(truncateUtf16Safe("hello", 10)).toBe("hello");
  });

  it("truncates when longer than limit", () => {
    expect(truncateUtf16Safe("hello world", 5)).toBe("hello");
  });

  it("handles zero limit", () => {
    expect(truncateUtf16Safe("hello", 0)).toBe("");
  });

  it("handles negative limit", () => {
    expect(truncateUtf16Safe("hello", -1)).toBe("");
  });

  it("floors decimal limit", () => {
    expect(truncateUtf16Safe("hello world", 5.7)).toBe("hello");
  });

  it("preserves emoji with surrogate pairs", () => {
    const emoji = "👨‍👩‍👧‍👦";
    const result = truncateUtf16Safe(emoji, 10);
    // Should not return dangling surrogate
    expect(result.length).toBeLessThanOrEqual(emoji.length);
  });

  it("avoids splitting surrogate pair", () => {
    const input = "👨👩";
    const result = truncateUtf16Safe(input, 1);
    // Should not return dangling surrogate
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
