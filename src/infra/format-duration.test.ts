import { describe, expect, it } from "vitest";
import { formatDurationSeconds, formatDurationMs } from "./format-duration.js";

describe("formatDurationSeconds", () => {
  it("converts milliseconds to seconds with default options", () => {
    expect(formatDurationSeconds(1500)).toBe("1.5s");
    expect(formatDurationSeconds(3000)).toBe("3s");
  });

  it("trims trailing zeros", () => {
    expect(formatDurationSeconds(2000)).toBe("2s");
    expect(formatDurationSeconds(1100)).toBe("1.1s");
    expect(formatDurationSeconds(1010)).toBe("1s");
  });

  it("respects decimals option", () => {
    expect(formatDurationSeconds(1234, { decimals: 0 })).toBe("1s");
    expect(formatDurationSeconds(1234, { decimals: 2 })).toBe("1.23s");
    expect(formatDurationSeconds(1234, { decimals: 3 })).toBe("1.234s");
  });

  it("supports 'seconds' unit", () => {
    expect(formatDurationSeconds(2500, { unit: "seconds" })).toBe("2.5 seconds");
    expect(formatDurationSeconds(3000, { unit: "seconds" })).toBe("3 seconds");
  });

  it("clamps negative values to zero", () => {
    expect(formatDurationSeconds(-500)).toBe("0s");
    expect(formatDurationSeconds(-1)).toBe("0s");
  });

  it("handles zero", () => {
    expect(formatDurationSeconds(0)).toBe("0s");
  });

  it("returns 'unknown' for non-finite values", () => {
    expect(formatDurationSeconds(NaN)).toBe("unknown");
    expect(formatDurationSeconds(Infinity)).toBe("unknown");
    expect(formatDurationSeconds(-Infinity)).toBe("unknown");
  });
});

describe("formatDurationMs", () => {
  it("returns milliseconds for values under 1000ms", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(1)).toBe("1ms");
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("converts to seconds at 1000ms and above", () => {
    expect(formatDurationMs(1000)).toBe("1s");
    expect(formatDurationMs(1500)).toBe("1.5s");
    expect(formatDurationMs(2345)).toBe("2.35s");
  });

  it("trims trailing zeros in seconds", () => {
    expect(formatDurationMs(5000)).toBe("5s");
    expect(formatDurationMs(10_000)).toBe("10s");
  });

  it("defaults to 2 decimals for seconds", () => {
    expect(formatDurationMs(1234)).toBe("1.23s");
    expect(formatDurationMs(1050)).toBe("1.05s");
  });

  it("respects decimals option", () => {
    expect(formatDurationMs(1234, { decimals: 0 })).toBe("1s");
    expect(formatDurationMs(1234, { decimals: 3 })).toBe("1.234s");
  });

  it("supports 'seconds' unit", () => {
    expect(formatDurationMs(2500, { unit: "seconds" })).toBe("2.5 seconds");
  });

  it("returns 'unknown' for non-finite values", () => {
    expect(formatDurationMs(NaN)).toBe("unknown");
    expect(formatDurationMs(Infinity)).toBe("unknown");
  });
});
