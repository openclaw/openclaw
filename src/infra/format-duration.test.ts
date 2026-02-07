import { describe, expect, it } from "vitest";
import { formatDurationSeconds, formatDurationMs } from "./format-duration.js";

describe("formatDurationSeconds", () => {
  it("formats milliseconds to seconds with default unit", () => {
    expect(formatDurationSeconds(1500)).toBe("1.5s");
  });

  it("formats zero", () => {
    expect(formatDurationSeconds(0)).toBe("0s");
  });

  it("trims trailing zeros", () => {
    expect(formatDurationSeconds(2000)).toBe("2s");
    expect(formatDurationSeconds(2100)).toBe("2.1s");
  });

  it("returns 'unknown' for non-finite values", () => {
    expect(formatDurationSeconds(Infinity)).toBe("unknown");
    expect(formatDurationSeconds(NaN)).toBe("unknown");
  });

  it("clamps negative to 0", () => {
    expect(formatDurationSeconds(-500)).toBe("0s");
  });

  it("respects decimals option", () => {
    expect(formatDurationSeconds(1234, { decimals: 2 })).toBe("1.23s");
  });

  it("supports 'seconds' unit", () => {
    expect(formatDurationSeconds(3000, { unit: "seconds" })).toBe("3 seconds");
  });
});

describe("formatDurationMs", () => {
  it("returns ms for values under 1000", () => {
    expect(formatDurationMs(500)).toBe("500ms");
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("returns seconds for values >= 1000", () => {
    expect(formatDurationMs(1000)).toBe("1s");
    expect(formatDurationMs(1500)).toBe("1.5s");
  });

  it("returns 'unknown' for non-finite", () => {
    expect(formatDurationMs(Infinity)).toBe("unknown");
    expect(formatDurationMs(NaN)).toBe("unknown");
  });

  it("supports 'seconds' unit for large values", () => {
    expect(formatDurationMs(2000, { unit: "seconds" })).toBe("2 seconds");
  });
});
