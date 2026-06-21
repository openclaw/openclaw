// Control UI tests for the compact token count formatter shared across chat surfaces.
import { describe, expect, it } from "vitest";
import { formatCompactTokenCount } from "./token-format.ts";

describe("formatCompactTokenCount", () => {
  it("formats values under 1,000 as-is", () => {
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(999)).toBe("999");
  });

  it("formats thousands with one decimal, trimming a trailing .0", () => {
    expect(formatCompactTokenCount(1_000)).toBe("1k");
    expect(formatCompactTokenCount(214_500)).toBe("214.5k");
    expect(formatCompactTokenCount(99_950)).toBe("100k");
  });

  it("formats millions with one decimal, trimming a trailing .0", () => {
    expect(formatCompactTokenCount(1_000_000)).toBe("1M");
    expect(formatCompactTokenCount(1_500_000)).toBe("1.5M");
  });

  it("rolls values that round up to 1000.0k over into the M branch instead of showing 1000k", () => {
    // Regression test: 999,500-999,999 round to "1000.0" at one-decimal
    // thousands precision. Before the fix, the >= 1_000_000 branch check
    // ran on the raw value (which is still < 1_000_000), so these fell
    // through to the k branch and displayed the nonsensical "1000k".
    expect(formatCompactTokenCount(999_999)).toBe("1M");
    expect(formatCompactTokenCount(999_950)).toBe("1M");
    expect(formatCompactTokenCount(999_500)).toBe("999.5k");
  });

  it("does not roll over values just below the rounding boundary", () => {
    expect(formatCompactTokenCount(999_949)).toBe("999.9k");
    expect(formatCompactTokenCount(999_499)).toBe("999.5k");
  });
});
