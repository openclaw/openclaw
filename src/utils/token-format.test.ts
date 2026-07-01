// Token format tests cover compact human-facing token count display.
import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./token-format.js";

describe("formatTokenCount", () => {
  it("returns 0 for undefined or non-finite values", () => {
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatTokenCount(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("returns 0 for zero or negative values", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-100)).toBe("0");
  });

  it("renders small values as integers", () => {
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("renders thousands with k suffix", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(9999)).toBe("10.0k");
  });

  it("renders ten-thousands and above as whole k", () => {
    expect(formatTokenCount(10000)).toBe("10k");
    expect(formatTokenCount(50000)).toBe("50k");
    expect(formatTokenCount(999000)).toBe("999k");
  });

  it("renders millions with m suffix", () => {
    expect(formatTokenCount(1000000)).toBe("1.0m");
    expect(formatTokenCount(1500000)).toBe("1.5m");
    expect(formatTokenCount(10000000)).toBe("10.0m");
  });

  it("overflows thousands to millions when rounding crosses boundary", () => {
    // 999,999 / 1000 = 999.999 → toFixed(1) = "1000.0" → crosses to millions
    expect(formatTokenCount(999999)).toBe("1.0m");
  });
});
