import { describe, expect, it } from "vitest";
import { formatDurationElapsed } from "../../scripts/lib/format-duration.mts";

describe("formatDurationElapsed", () => {
  it.each<[number, 1 | 2, string]>([
    [0, 1, "0ms"],
    [999, 1, "999ms"],
    [1_000, 1, "1s"],
    [1_100, 2, "1.10s"],
    [1_230, 2, "1.23s"],
    [3_100, 1, "3.1s"],
    [10_000, 2, "10s"],
    [12_300, 1, "12.3s"],
    [59_900, 1, "59.9s"],
    [60_000, 1, "1m"],
    [60_100, 1, "1m 0.1s"],
    [3_661_100, 1, "1h 1m 1.1s"],
    [86_400_100, 1, "1d 0.1s"],
    [31_626_061_100, 1, "1y 1d 1h 1m 1.1s"],
  ])("formats %dms with %d second decimals", (input, secondsDecimalDigits, expected) => {
    expect(formatDurationElapsed(input, { secondsDecimalDigits })).toBe(expected);
  });

  it("folds years into days for smoke timings and skips empty units", () => {
    expect(formatDurationElapsed(31_622_401_000, { showYears: false, unitCount: 2 })).toBe(
      "366d 1s",
    );
  });

  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1_100, "1.1s"],
    [59_900, "59.9s"],
    [60_100, "1m"],
    [3_660_000, "1h"],
    [31_622_400_000, "1y"],
  ])("keeps only the first nonzero timing unit for %dms", (input, expected) => {
    expect(formatDurationElapsed(input, { unitCount: 1 })).toBe(expected);
  });
});
