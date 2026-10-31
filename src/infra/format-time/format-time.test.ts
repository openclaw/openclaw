import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimeZoneDayStartMs,
  resolveTimezone,
} from "./format-datetime.js";
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

afterEach(() => vi.restoreAllMocks());

it.each([
  [null, undefined, undefined],
  [0.1, undefined, "0ms"],
  [999, undefined, "999ms"],
  [999.6, undefined, "1s"],
  [59000, undefined, "59s"],
  [60000, undefined, "1m"],
  [65000, undefined, "1m5s"],
  [3600000, undefined, "1h"],
  [3660000, undefined, "1h1m"],
  [3630000, undefined, "1h30s"],
  [86400000, undefined, "1d"],
  [90000000, undefined, "1d1h"],
  [86_430_000, undefined, "1d30s"],
  [3_599_500, undefined, "1h"],
  [86_399_500, undefined, "1d"],
  [366 * 86400000, undefined, "366d"],
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

it.each([
  [500, "500ms"],
  [999.6, "1s"],
  [180000, "3m"],
  [7200000, "2h"],
  [23 * 3600000, "23h"],
  [24 * 3600000, "1d"],
  [25 * 3600000, "1d"],
  [86_370_000, "1d"],
])("formats human duration for %j", (input, expected) => {
  expect(formatDurationHuman(input)).toBe(expected);
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

it.each([
  [0, undefined, "just now"],
  [29000, undefined, "just now"],
  [30000, undefined, "1m ago"],
  [47 * 3600000, undefined, "47h ago"],
  [48 * 3600000, undefined, "2d ago"],
  [0, { suffix: false }, "0s"],
  [7200000, { suffix: false }, "2h"],
] as const)("formats relative age for %j (%j)", (input, options, expected) => {
  expect(formatTimeAgo(input, options)).toBe(expected);
});

describe("formatRelativeTimestamp", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2024-02-10T12:00:00.000Z") }));

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
