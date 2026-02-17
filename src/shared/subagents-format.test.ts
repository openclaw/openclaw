import { describe, expect, it } from "vitest";
import {
  formatDurationCompact,
  formatTokenShort,
  formatTokenUsageDisplay,
  resolveIoTokens,
  resolveTotalTokens,
  truncateLine,
} from "./subagents-format.js";

describe("formatDurationCompact", () => {
  it("returns n/a for undefined/zero/negative", () => {
    expect(formatDurationCompact(undefined)).toBe("n/a");
    expect(formatDurationCompact(0)).toBe("n/a");
    expect(formatDurationCompact(-1000)).toBe("n/a");
    expect(formatDurationCompact(NaN)).toBe("n/a");
    expect(formatDurationCompact(Infinity)).toBe("n/a");
  });

  it("formats minutes", () => {
    expect(formatDurationCompact(30_000)).toBe("1m"); // rounds to min 1
    expect(formatDurationCompact(60_000)).toBe("1m");
    expect(formatDurationCompact(5 * 60_000)).toBe("5m");
    expect(formatDurationCompact(59 * 60_000)).toBe("59m");
  });

  it("formats hours", () => {
    expect(formatDurationCompact(60 * 60_000)).toBe("1h");
    expect(formatDurationCompact(90 * 60_000)).toBe("1h30m");
    expect(formatDurationCompact(23 * 60 * 60_000)).toBe("23h");
  });

  it("formats days", () => {
    expect(formatDurationCompact(24 * 60 * 60_000)).toBe("1d");
    expect(formatDurationCompact(25 * 60 * 60_000)).toBe("1d1h");
    expect(formatDurationCompact(48 * 60 * 60_000)).toBe("2d");
  });
});

describe("formatTokenShort", () => {
  it("returns undefined for invalid values", () => {
    expect(formatTokenShort(undefined)).toBeUndefined();
    expect(formatTokenShort(0)).toBeUndefined();
    expect(formatTokenShort(-5)).toBeUndefined();
    expect(formatTokenShort(NaN)).toBeUndefined();
  });

  it("formats small numbers", () => {
    expect(formatTokenShort(1)).toBe("1");
    expect(formatTokenShort(999)).toBe("999");
  });

  it("formats thousands with decimal", () => {
    expect(formatTokenShort(1500)).toBe("1.5k");
    expect(formatTokenShort(9999)).toBe("10k");
  });

  it("formats large thousands", () => {
    expect(formatTokenShort(10_000)).toBe("10k");
    expect(formatTokenShort(500_000)).toBe("500k");
  });

  it("formats millions", () => {
    expect(formatTokenShort(1_000_000)).toBe("1m");
    expect(formatTokenShort(1_500_000)).toBe("1.5m");
  });
});

describe("truncateLine", () => {
  it("returns short strings unchanged", () => {
    expect(truncateLine("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis", () => {
    expect(truncateLine("hello world", 5)).toBe("hello...");
  });

  it("trims trailing whitespace before ellipsis", () => {
    expect(truncateLine("hi   there", 4)).toBe("hi...");
  });
});

describe("resolveTotalTokens", () => {
  it("returns undefined for missing/invalid input", () => {
    expect(resolveTotalTokens(undefined)).toBeUndefined();
    expect(resolveTotalTokens(null as unknown)).toBeUndefined();
  });

  it("prefers totalTokens", () => {
    expect(resolveTotalTokens({ totalTokens: 100 })).toBe(100);
  });

  it("sums input + output when totalTokens missing", () => {
    expect(resolveTotalTokens({ inputTokens: 50, outputTokens: 30 })).toBe(80);
  });

  it("returns undefined when sum is 0", () => {
    expect(resolveTotalTokens({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

describe("resolveIoTokens", () => {
  it("returns undefined for missing input", () => {
    expect(resolveIoTokens(undefined)).toBeUndefined();
  });

  it("returns structured tokens", () => {
    expect(resolveIoTokens({ inputTokens: 100, outputTokens: 50 })).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });

  it("returns undefined when both are 0", () => {
    expect(resolveIoTokens({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });

  it("handles non-finite values as 0", () => {
    expect(resolveIoTokens({ inputTokens: NaN, outputTokens: 50 })).toEqual({
      input: 0,
      output: 50,
      total: 50,
    });
  });
});

describe("formatTokenUsageDisplay", () => {
  it("returns empty string for missing data", () => {
    expect(formatTokenUsageDisplay(undefined)).toBe("");
  });

  it("formats io tokens", () => {
    const result = formatTokenUsageDisplay({ inputTokens: 1000, outputTokens: 500 });
    expect(result).toContain("tokens");
    expect(result).toContain("in");
    expect(result).toContain("out");
  });
});
