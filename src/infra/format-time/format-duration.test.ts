import { describe, expect, it } from "vitest";
import {
  formatDurationSeconds,
  formatDurationPrecise,
  formatDurationCompact,
  formatDurationRounded,
} from "./format-duration.js";

describe("formatDurationSeconds", () => {
  it("formats milliseconds to seconds", () => {
    expect(formatDurationSeconds(5000)).toBe("5.0s");
    expect(formatDurationSeconds(1500)).toBe("1.5s");
    expect(formatDurationSeconds(100)).toBe("0.1s");
  });

  it("handles custom decimals", () => {
    expect(formatDurationSeconds(1234, { decimals: 0 })).toBe("1s");
    expect(formatDurationSeconds(1234, { decimals: 2 })).toBe("1.23s");
    expect(formatDurationSeconds(1234, { decimals: 3 })).toBe("1.234s");
  });

  it("handles 'seconds' unit", () => {
    expect(formatDurationSeconds(5000, { unit: "seconds" })).toBe("5.0 seconds");
    expect(formatDurationSeconds(1000, { unit: "seconds" })).toBe("1.0 seconds");
  });

  it("trims trailing zeros", () => {
    expect(formatDurationSeconds(5000, { decimals: 2 })).toBe("5s");
    expect(formatDurationSeconds(5500, { decimals: 2 })).toBe("5.5s");
  });

  it("handles non-finite values", () => {
    expect(formatDurationSeconds(NaN)).toBe("unknown");
    expect(formatDurationSeconds(Infinity)).toBe("unknown");
    expect(formatDurationSeconds(-Infinity)).toBe("unknown");
  });

  it("handles negative values", () => {
    expect(formatDurationSeconds(-5000)).toBe("0.0s");
  });
});

describe("formatDurationPrecise", () => {
  it("shows milliseconds for small values", () => {
    expect(formatDurationPrecise(500)).toBe("500ms");
    expect(formatDurationPrecise(999)).toBe("999ms");
  });

  it("shows seconds for larger values", () => {
    expect(formatDurationPrecise(1000)).toBe("1.00s");
    expect(formatDurationPrecise(1500)).toBe("1.50s");
    expect(formatDurationPrecise(5000)).toBe("5.00s");
  });

  it("handles non-finite values", () => {
    expect(formatDurationPrecise(NaN)).toBe("unknown");
    expect(formatDurationPrecise(Infinity)).toBe("unknown");
  });
});

describe("formatDurationCompact", () => {
  it("formats milliseconds", () => {
    expect(formatDurationCompact(500)).toBe("500ms");
    expect(formatDurationCompact(999)).toBe("999ms");
  });

  it("formats seconds", () => {
    expect(formatDurationCompact(5000)).toBe("5s");
    expect(formatDurationCompact(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationCompact(65000)).toBe("1m5s");
    expect(formatDurationCompact(125000)).toBe("2m5s");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationCompact(3660000)).toBe("1h1m");
    expect(formatDurationCompact(7200000)).toBe("2h");
  });

  it("formats days", () => {
    expect(formatDurationCompact(86400000)).toBe("1d");
    expect(formatDurationCompact(90000000)).toBe("1d1h");
  });

  it("handles spaced option", () => {
    expect(formatDurationCompact(65000, { spaced: true })).toBe("1m 5s");
    expect(formatDurationCompact(3660000, { spaced: true })).toBe("1h 1m");
  });

  it("returns undefined for invalid input", () => {
    expect(formatDurationCompact(null)).toBeUndefined();
    expect(formatDurationCompact(undefined)).toBeUndefined();
    expect(formatDurationCompact(NaN)).toBeUndefined();
    expect(formatDurationCompact(-100)).toBeUndefined();
    expect(formatDurationCompact(0)).toBeUndefined();
  });
});

describe("formatDurationRounded", () => {
  it("rounds to single unit", () => {
    expect(formatDurationRounded(500)).toBe("500ms");
    expect(formatDurationRounded(5000)).toBe("5s");
    expect(formatDurationRounded(180000)).toBe("3m");
    expect(formatDurationRounded(7200000)).toBe("2h");
    expect(formatDurationRounded(86400000)).toBe("1d");
  });

  it("rounds to nearest unit", () => {
    expect(formatDurationRounded(55000)).toBe("1m"); // 55s rounds to 1m
    expect(formatDurationRounded(90000)).toBe("2m"); // 90s rounds to 2m
  });

  it("handles custom fallback", () => {
    expect(formatDurationRounded(null, { fallback: "N/A" })).toBe("N/A");
    expect(formatDurationRounded(undefined, { fallback: "-" })).toBe("-");
  });

  it("returns default fallback for invalid input", () => {
    expect(formatDurationRounded(null)).toBe("-");
    expect(formatDurationRounded(NaN)).toBe("-");
    expect(formatDurationRounded(-100)).toBe("-");
  });
});
