// Subagent format tests cover concise subagent status and duration formatting.
import { describe, expect, it } from "vitest";
import {
  formatDurationCompact,
  formatTokenShort,
  formatTokenUsageDisplay,
  resolveIoTokens,
  resolveTotalTokens,
  truncateLine,
} from "./subagents-format.js";

describe("shared/subagents-format", () => {
  it("re-exports the canonical formatter with second-level precision", () => {
    expect(formatDurationCompact()).toBeUndefined();
    expect(formatDurationCompact(30_000)).toBe("30s");
    expect(formatDurationCompact(90_000)).toBe("1m30s");
    expect(formatDurationCompact(60 * 60_000)).toBe("1h");
    expect(formatDurationCompact(61 * 60_000)).toBe("1h1m");
    expect(formatDurationCompact(24 * 60 * 60_000)).toBe("1d");
    expect(formatDurationCompact(25 * 60 * 60_000)).toBe("1d1h");
  });

  it("formats token counts with integer, kilo, and million branches", () => {
    expect(formatTokenShort()).toBeUndefined();
    expect(formatTokenShort(999.9)).toBe("999");
    expect(formatTokenShort(1_500)).toBe("1.5k");
    expect(formatTokenShort(10_000)).toBe("10k");
    expect(formatTokenShort(15_400)).toBe("15k");
    // Rollover boundary: rounding to thousands must not emit an out-of-scheme
    // "1000k" — it has to advance to the million branch.
    expect(formatTokenShort(999_499)).toBe("999k");
    expect(formatTokenShort(999_500)).toBe("1m");
    expect(formatTokenShort(999_999)).toBe("1m");
    expect(formatTokenShort(1_000_000)).toBe("1m");
    expect(formatTokenShort(1_250_000)).toBe("1.3m");
  });

  it("truncates lines only when needed", () => {
    expect(truncateLine("short", 10)).toBe("short");
    expect(truncateLine("trim me   ", 7)).toBe("trim me...");
  });

  it("never cuts a surrogate pair in half when truncating", () => {
    // "y" x47 (units 0..46), then 😀 occupying units 47-48, then "tail".
    // A raw value.slice(0, 48) would keep the lone high surrogate at unit 47,
    // emitting a broken label that ends with an unpaired surrogate before "...".
    const value = `${"y".repeat(47)}\u{1F600}tail`;
    const result = truncateLine(value, 48);
    expect(result).toBe(`${"y".repeat(47)}...`);
    // No dangling/lone surrogate code unit anywhere in the displayed label.
    for (const codeUnit of result) {
      const code = codeUnit.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
    // The emoji fully fits below the limit, so it is preserved intact.
    expect(truncateLine(`${"y".repeat(46)}\u{1F600}tail`, 48)).toBe(
      `${"y".repeat(46)}\u{1F600}...`,
    );
  });

  it("resolves token totals and io breakdowns from valid numeric fields only", () => {
    expect(resolveTotalTokens()).toBeUndefined();
    expect(resolveTotalTokens({ totalTokens: 42 })).toBe(42);
    expect(resolveTotalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
    expect(resolveTotalTokens({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined();

    expect(resolveIoTokens({ inputTokens: 10, outputTokens: 5 })).toEqual({
      input: 10,
      output: 5,
      total: 15,
    });
    expect(resolveIoTokens({ outputTokens: 5 })).toEqual({
      input: 0,
      output: 5,
      total: 5,
    });
    expect(resolveIoTokens({ inputTokens: Number.NaN, outputTokens: 0 })).toBeUndefined();
  });

  it("formats io and prompt-cache usage displays with fallback branches", () => {
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 2_100,
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300), prompt/cache 2.1k");

    expect(formatTokenUsageDisplay({ totalTokens: 500 })).toBe("tokens 500 prompt/cache");
    expect(
      formatTokenUsageDisplay({
        inputTokens: 1_200,
        outputTokens: 300,
        totalTokens: 1_500,
      }),
    ).toBe("tokens 1.5k (in 1.2k / out 300)");
    expect(formatTokenUsageDisplay({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe("");
  });
});
