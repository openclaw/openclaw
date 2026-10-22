import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimeZoneDayStartMs,
  resolveTimezone,
} from "./format-datetime.js";
import { formatDurationParts, resolveSingleUnitDurationParts } from "./format-duration-internal.js";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatDurationPrecise,
  formatDurationSeconds,
} from "./format-duration.js";
import { formatTimeAgo, formatRelativeTimestamp } from "./format-relative.js";

const invalidDurationInputs = [null, undefined, -100] as const;
const timestamp = new Date("2024-01-15T14:30:45.000Z");
const utcOptions = { timeZone: "UTC" };

function expectFormatterCases<TInput, TOutput>(
  formatter: (value: TInput) => TOutput,
  cases: ReadonlyArray<readonly [TInput, TOutput]>,
) {
  for (const [input, expected] of cases) {
    expect(formatter(input), String(input)).toBe(expected);
  }
}

afterEach(() => vi.restoreAllMocks());

it.each([null])("formatDurationCompact returns undefined for %j", (value) => {
  expect(formatDurationCompact(value)).toBeUndefined();
});

it("formats compact units and omits trailing zero components", () => {
  expectFormatterCases(formatDurationCompact, [
    [0.1, "0ms"],
    [500, "500ms"],
    [999, "999ms"],
    [999.6, "1s"],
    [1000, "1s"],
    [45000, "45s"],
    [59000, "59s"],
    [60000, "1m"],
    [65000, "1m5s"],
    [90000, "1m30s"],
    [3600000, "1h"],
    [3660000, "1h1m"],
    [3630000, "1h30s"],
    [5400000, "1h30m"],
    [86400000, "1d"],
    [90000000, "1d1h"],
    [172800000, "2d"],
    [86_430_000, "1d30s"],
    [3_599_500, "1h"],
    [86_399_500, "1d"],
    [366 * 86400000, "366d"],
  ]);
});

it.each([
  [366 * 86400000, { showYears: true, spaced: true }, "1y 1d"],
  [18_014_398_509_513_598_976, undefined, "208499982749d"],
] as const)("formats compact duration for %j", (input, options, expected) => {
  expect(formatDurationCompact(input, options)).toBe(expected);
});
it("formatDurationHuman returns fallback for invalid duration input", () => {
  for (const value of invalidDurationInputs) {
    expect(formatDurationHuman(value)).toBe("n/a");
  }
  expect(formatDurationHuman(null, "unknown")).toBe("unknown");
});

it("formats single-unit outputs and day threshold behavior", () => {
  expectFormatterCases(formatDurationHuman, [
    [500, "500ms"],
    [999.6, "1s"],
    [5000, "5s"],
    [180000, "3m"],
    [7200000, "2h"],
    [23 * 3600000, "23h"],
    [24 * 3600000, "1d"],
    [25 * 3600000, "1d"],
    [172800000, "2d"],
  ]);
});
it.each([
  [86_370_000, "1 day"],
  [43_200_000, "12 hours"],
] as const)("formats rounded verbose duration for %j", (input, expected) => {
  expect(formatDurationParts(resolveSingleUnitDurationParts(input), true)).toBe(expected);
});
it.each([
  [999, "999ms"],
  [999.6, "1s"],
  [Infinity, "unknown"],
] as const)("formats precise duration for %j", (input, expected) => {
  expect(formatDurationPrecise(input)).toBe(expected);
});
it.each([
  [1500, { decimals: 1 }, "1.5s"],
  [2000, { unit: "seconds" }, "2 seconds"],
  [Infinity, undefined, "unknown"],
] as const)("formats seconds duration for %j", (input, options, expected) => {
  expect(formatDurationSeconds(input, options)).toBe(expected);
});
it("resolveTimezone validates IANA zones before retaining the most recent result", () => {
  expect(resolveTimezone("UTC")).toBe("UTC");
  expect(resolveTimezone("Invalid/Timezone")).toBeUndefined();
  expect(resolveTimezone("Europe/London")).toBe("Europe/London");
  expect(resolveTimezone("UTC")).toBe("UTC");
});
it("resolves calendar boundaries across a DST-short day", () => {
  const start = resolveTimeZoneDayStartMs("2026-03-29", "Europe/Vienna");
  const next = resolveTimeZoneDayStartMs("2026-03-30", "Europe/Vienna");

  expect(start).toBe(Date.parse("2026-03-28T23:00:00.000Z"));
  expect(next).toBe(Date.parse("2026-03-29T22:00:00.000Z"));
  expect(next! - start!).toBe(23 * 60 * 60 * 1000);
});
it.each([
  [undefined, "2024-01-15T14:30Z"],
  [{ displaySeconds: true }, "2024-01-15T14:30:45Z"],
] as const)("formats UTC timestamp (%j)", (options, expected) => {
  expect(formatUtcTimestamp(timestamp, options)).toBe(expected);
});

it.each([
  [{ ...utcOptions, displaySeconds: true }, /2024-01-15 14:30:45/],
  [{ ...utcOptions, displayWeekday: true }, /^Mon 2024-01-15 14:30 UTC$/],
] as const)("formats zoned timestamp (%j)", (options, expected) => {
  expect(formatZonedTimestamp(timestamp, options)).toMatch(expected);
});

it("follows host timezone changes while keeping explicit zones fixed", () => {
  for (const [timezone, expected] of [
    ["UTC", "2024-01-15 14:30 UTC"],
    ["America/New_York", "2024-01-15 09:30 EST"],
    ["UTC", "2024-01-15 14:30 UTC"],
  ]) {
    withEnv({ TZ: timezone }, () => {
      expect(formatZonedTimestamp(timestamp)).toBe(expected);
      expect(formatZonedTimestamp(timestamp, utcOptions)).toBe("2024-01-15 14:30 UTC");
    });
  }
});

it("returns undefined when required Intl parts are missing", () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue([
    { type: "month", value: "01" },
    { type: "day", value: "15" },
    { type: "hour", value: "14" },
    { type: "minute", value: "30" },
  ]);
  expect(formatZonedTimestamp(timestamp, utcOptions)).toBeUndefined();
});

it("returns undefined when Intl formatting throws", () => {
  vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
    throw new Error("boom");
  });
  expect(formatZonedTimestamp(timestamp, utcOptions)).toBeUndefined();
});
it("formatTimeAgo returns fallback for invalid elapsed input", () => {
  for (const value of invalidDurationInputs) {
    expect(formatTimeAgo(value)).toBe("unknown");
  }
  expect(formatTimeAgo(null, { fallback: "n/a" })).toBe("n/a");
});

it("formats relative age around key unit boundaries", () => {
  expectFormatterCases(formatTimeAgo, [
    [0, "just now"],
    [29000, "just now"],
    [30000, "1m ago"],
    [300000, "5m ago"],
    [7200000, "2h ago"],
    [47 * 3600000, "47h ago"],
    [48 * 3600000, "2d ago"],
  ]);
});

it.each([
  [0, "0s"],
  [7200000, "2h"],
] as const)("omits suffix for %j when disabled", (input, expected) => {
  expect(formatTimeAgo(input, { suffix: false })).toBe(expected);
});

describe("formatRelativeTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-10T12:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("returns fallback for invalid timestamp input", () => {
    for (const value of [null, undefined]) {
      expect(formatRelativeTimestamp(value)).toBe("");
    }
  });

  it.each([
    [-30000, "just now"],
    [30000, "in <1m"],
  ] as const)("formats relative timestamp for offset %d", (offsetMs, expected) => {
    expect(formatRelativeTimestamp(Date.now() + offsetMs)).toBe(expected);
  });

  it("keeps 7-day-old timestamps relative", () => {
    expect(formatRelativeTimestamp(Date.now() - 7 * 86400000)).toBe("7d ago");
  });

  it("falls back to relative days when date formatting throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      throw new RangeError("synthetic formatter failure");
    });
    expect(formatRelativeTimestamp(Date.now() + 8 * 86400000)).toBe("in 8d");
  });
});
