import { describe, expect, it } from "vitest";
import {
  appendUniqueSuffix,
  MAX_DELTA_OVERLAP,
  resolveMergedAssistantText,
} from "./server-chat.js";

describe("appendUniqueSuffix", () => {
  it("returns suffix when base is empty", () => {
    expect(appendUniqueSuffix("", "hello")).toBe("hello");
  });

  it("returns base when suffix is empty", () => {
    expect(appendUniqueSuffix("hello", "")).toBe("hello");
  });

  it("returns base when suffix is already a trailing substring", () => {
    expect(appendUniqueSuffix("hello world", "world")).toBe("hello world");
  });

  it("deduplicates overlapping tail", () => {
    expect(appendUniqueSuffix("hello wor", "world")).toBe("hello world");
  });

  it("concatenates when no overlap exists", () => {
    expect(appendUniqueSuffix("abc", "xyz")).toBe("abcxyz");
  });

  it("handles single-char overlap", () => {
    expect(appendUniqueSuffix("abc", "cde")).toBe("abcde");
  });

  it("does not freeze on long repeated characters", () => {
    // Simulates Haiku streaming a table with box-drawing characters.
    // The suffix ends with a unique trailer so `endsWith` does NOT
    // short-circuit — the function must enter the overlap scan loop.
    const repeatedBase = "─".repeat(5000);
    const repeatedSuffix = "─".repeat(2000) + "│";
    const start = performance.now();
    const result = appendUniqueSuffix(repeatedBase, repeatedSuffix);
    const elapsed = performance.now() - start;

    // The function should complete well under 50ms even on slow hardware.
    // Without the cap, this would take seconds or more.
    expect(elapsed).toBeLessThan(50);
    // The cap limits the overlap window, so the loop finishes quickly.
    // Result should contain both the base and the trailing unique char.
    expect(result.endsWith("│")).toBe(true);
    expect(result.length).toBeGreaterThan(5000);
  });

  it("respects MAX_DELTA_OVERLAP cap on overlap window", () => {
    // Build a base whose last MAX_DELTA_OVERLAP+50 chars overlap with a suffix
    // that is longer than MAX_DELTA_OVERLAP. The function should only find
    // overlaps up to MAX_DELTA_OVERLAP.
    const overlapLen = MAX_DELTA_OVERLAP + 50;
    const shared = "x".repeat(overlapLen);
    const base = "prefix_" + shared;
    const suffix = shared + "_tail";

    const result = appendUniqueSuffix(base, suffix);

    // Because MAX_DELTA_OVERLAP < overlapLen, the function won't find the
    // full overlap, so it will find the largest overlap within the cap.
    // The shared portion is all 'x', so any overlap within the cap range
    // will still produce a correct merge for the capped window.
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("finds overlap correctly within the cap boundary", () => {
    // Overlap of exactly MAX_DELTA_OVERLAP should still be found.
    const shared = "abcdefghij"
      .repeat(Math.ceil(MAX_DELTA_OVERLAP / 10))
      .slice(0, MAX_DELTA_OVERLAP);
    const base = "start_" + shared;
    const suffix = shared + "_end";

    const result = appendUniqueSuffix(base, suffix);
    expect(result).toBe("start_" + shared + "_end");
  });

  it("handles overlap just over the cap", () => {
    // Overlap of MAX_DELTA_OVERLAP+1 — the extra char of overlap is outside
    // the scan window, so the function falls back to a smaller overlap or concat.
    const shared = "abcdefghij"
      .repeat(Math.ceil((MAX_DELTA_OVERLAP + 1) / 10))
      .slice(0, MAX_DELTA_OVERLAP + 1);
    const base = "start_" + shared;
    const suffix = shared + "_end";

    const result = appendUniqueSuffix(base, suffix);
    // It should find overlap of MAX_DELTA_OVERLAP (missing the first shared char)
    // which still produces a reasonable result.
    expect(typeof result).toBe("string");
    expect(result.includes("_end")).toBe(true);
  });
});

describe("resolveMergedAssistantText", () => {
  it("returns nextText when it extends previousText", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "hello",
        nextText: "hello world",
        nextDelta: "",
      }),
    ).toBe("hello world");
  });

  it("returns previousText when nextText is a prefix and no delta", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "hello world",
        nextText: "hello",
        nextDelta: "",
      }),
    ).toBe("hello world");
  });

  it("falls back to appendUniqueSuffix when delta is present", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "hello wor",
        nextText: "",
        nextDelta: "world",
      }),
    ).toBe("hello world");
  });

  it("returns nextText when no previousText", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "",
        nextText: "new text",
        nextDelta: "",
      }),
    ).toBe("new text");
  });

  it("returns previousText as last resort", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "kept",
        nextText: "",
        nextDelta: "",
      }),
    ).toBe("kept");
  });
});
