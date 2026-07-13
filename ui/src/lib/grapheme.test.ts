import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeGraphemes } from "./grapheme.ts";

describe("takeGraphemes", () => {
  it("returns the first N grapheme clusters for ASCII", () => {
    expect(takeGraphemes("Alice", 1)).toBe("A");
    expect(takeGraphemes("ab", 2)).toBe("ab");
    expect(takeGraphemes("abc", 5)).toBe("abc");
  });

  it("keeps emoji and joined clusters intact", () => {
    expect(takeGraphemes("😀Name", 1)).toBe("😀");
    expect(takeGraphemes("👨‍👩‍👧‍👦Family", 1)).toBe("👨‍👩‍👧‍👦");
    expect(takeGraphemes("🇺🇸Flag", 1)).toBe("🇺🇸");
    expect(takeGraphemes("👍🏻Thumbs", 1)).toBe("👍🏻");
  });

  it("returns an empty string for empty input", () => {
    expect(takeGraphemes("", 1)).toBe("");
  });
});

describe("takeGraphemes without Intl.Segmenter", () => {
  const originalIntlSegmenter = Intl.Segmenter;

  beforeEach(() => {
    // The segmenter is captured at module load, so the stub must precede a
    // fresh import to exercise the code-point fallback.
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    vi.resetModules();
  });

  afterEach(() => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: originalIntlSegmenter });
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to code-point slicing", async () => {
    const { takeGraphemes: fallbackTakeGraphemes } = await import("./grapheme.ts");
    expect(fallbackTakeGraphemes("Alice", 1)).toBe("A");
    expect(fallbackTakeGraphemes("ab", 2)).toBe("ab");
    // Astral code points stay intact; joined clusters collapse to the first code point.
    expect(fallbackTakeGraphemes("😀Name", 1)).toBe("😀");
    expect(fallbackTakeGraphemes("👨‍👩‍👧‍👦Family", 1)).toBe("👨");
    expect(fallbackTakeGraphemes("", 1)).toBe("");
  });
});
