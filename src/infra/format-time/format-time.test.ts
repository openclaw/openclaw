// Covers duration, UTC/zoned timestamp, timezone, and relative time formatting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import {
  createTimeZoneDayKeyFormatter,
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimeZoneDayStartMs,
  resolveTimezone,
} from "./format-datetime.js";
import { formatSingleUnitDuration } from "./format-duration-internal.js";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatDurationPrecise,
  formatDurationSeconds,
} from "./format-duration.js";
import { formatTimeAgo, formatRelativeTimestamp } from "./format-relative.js";

const invalidDurationInputs = [null, undefined, -100] as const;

function expectFormatterCases<TInput, TOutput>(
  formatter: (value: TInput) => TOutput,
  cases: ReadonlyArray<{ input: TInput; expected: TOutput }>,
) {
  for (const { input, expected } of cases) {
    expect(formatter(input), String(input)).toBe(expected);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("format-duration", () => {
  describe("formatDurationCompact", () => {
    it.each([null])("returns undefined for %j", (value) => {
      expect(formatDurationCompact(value)).toBeUndefined();
    });

    it("formats compact units and omits trailing zero components", () => {
      expectFormatterCases(formatDurationCompact, [
        { input: 0.1, expected: "0ms" },
        { input: 500, expected: "500ms" },
        { input: 999, expected: "999ms" },
        { input: 999.6, expected: "1s" },
        { input: 1000, expected: "1s" },
        { input: 45000, expected: "45s" },
        { input: 59000, expected: "59s" },
        { input: 60000, expected: "1m" },
        { input: 65000, expected: "1m5s" },
        { input: 90000, expected: "1m30s" },
        { input: 3600000, expected: "1h" },
        { input: 3660000, expected: "1h1m" },
        { input: 3630000, expected: "1h30s" },
        { input: 5400000, expected: "1h30m" },
        { input: 86400000, expected: "1d" },
        { input: 90000000, expected: "1d1h" },
        { input: 172800000, expected: "2d" },
        { input: 86_430_000, expected: "1d30s" },
        { input: 3_599_500, expected: "1h" },
        { input: 86_399_500, expected: "1d" },
        { input: 366 * 86400000, expected: "366d" },
      ]);
    });

    it.each([
      {
        input: 366 * 86400000,
        options: { showYears: true, spaced: true },
        expected: "1y 1d",
      },
      { input: 18_014_398_509_513_598_976, expected: "208499982749d" },
    ])("formats compact duration for %j", ({ input, options, expected }) => {
      expect(formatDurationCompact(input, options)).toBe(expected);
    });
  });

  describe("formatDurationHuman", () => {
    it("returns fallback for invalid duration input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatDurationHuman(value)).toBe("n/a");
      }
      expect(formatDurationHuman(null, "unknown")).toBe("unknown");
    });

    it("formats single-unit outputs and day threshold behavior", () => {
      expectFormatterCases(formatDurationHuman, [
        { input: 500, expected: "500ms" },
        { input: 999.6, expected: "1s" },
        { input: 5000, expected: "5s" },
        { input: 180000, expected: "3m" },
        { input: 7200000, expected: "2h" },
        { input: 23 * 3600000, expected: "23h" },
        { input: 24 * 3600000, expected: "1d" },
        { input: 25 * 3600000, expected: "1d" },
        { input: 172800000, expected: "2d" },
      ]);
    });
  });

  describe("formatSingleUnitDuration", () => {
    it.each([[86_370_000, "24 hours", "1 day"]])(
      "rolls over %dms to the next unit instead of %s",
      (input, _buggyOutput, expected) => {
        expect(formatSingleUnitDuration(input, true)).toBe(expected);
      },
    );

    it.each([[43_200_000, "12 hours"]])("keeps %dms in its own unit as %s", (input, expected) => {
      expect(formatSingleUnitDuration(input, true)).toBe(expected);
    });
  });

  describe("formatDurationPrecise", () => {
    it.each([
      { input: 999, expected: "999ms" },
      { input: 999.6, expected: "1s" },
      { input: Infinity, expected: "unknown" },
    ])("formats precise duration for %j", ({ input, expected }) => {
      expect(formatDurationPrecise(input)).toBe(expected);
    });
  });

  describe("formatDurationSeconds", () => {
    it.each([
      { input: 1500, options: { decimals: 1 }, expected: "1.5s" },
      { input: 2000, options: { unit: "seconds" as const }, expected: "2 seconds" },
      { input: Infinity, options: undefined, expected: "unknown" },
    ])("formats seconds duration for %j", ({ input, options, expected }) => {
      expect(formatDurationSeconds(input, options)).toBe(expected);
    });
  });
});

describe("format-datetime", () => {
  describe("resolveTimezone", () => {
    it("returns undefined on format failure and resolves again after restoration", () => {
      expect(resolveTimezone("UTC")).toBe("UTC");
      const failure = new Error("test timezone validation unavailable");
      const prototype = Intl.DateTimeFormat.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "format");
      if (!descriptor) {
        throw new Error("Intl.DateTimeFormat.format descriptor is missing");
      }
      Object.defineProperty(prototype, "format", {
        ...descriptor,
        get: () => () => {
          throw failure;
        },
      });
      try {
        expect(resolveTimezone("UTC")).toBeUndefined();
        expect(resolveTimezone("Europe/London")).toBeUndefined();
      } finally {
        Object.defineProperty(prototype, "format", descriptor);
      }
      expect(resolveTimezone("Europe/London")).toBe("Europe/London");
      expect(resolveTimezone("UTC")).toBe("UTC");
    });
  });

  describe("calendar days", () => {
    it("honors constructor failures and formats again after restoration", () => {
      const date = new Date("2024-01-01T00:30:00.000Z");
      expect(createTimeZoneDayKeyFormatter("UTC")(date)).toBe("2024-01-01");
      const failure = new Error("test formatter unavailable");
      const constructor = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
        throw failure;
      });
      try {
        expect(() => createTimeZoneDayKeyFormatter("UTC")).toThrow(failure);
      } finally {
        constructor.mockRestore();
      }
      expect(createTimeZoneDayKeyFormatter("UTC")(date)).toBe("2024-01-01");
    });

    it("resolves calendar boundaries across a DST-short day", () => {
      const start = resolveTimeZoneDayStartMs("2026-03-29", "Europe/Vienna");
      const next = resolveTimeZoneDayStartMs("2026-03-30", "Europe/Vienna");

      expect(start).toBe(Date.parse("2026-03-28T23:00:00.000Z"));
      expect(next).toBe(Date.parse("2026-03-29T22:00:00.000Z"));
      expect(next! - start!).toBe(23 * 60 * 60 * 1000);
    });
  });

  describe("formatUtcTimestamp", () => {
    it.each([
      { displaySeconds: false, expected: "2024-01-15T14:30Z" },
      { displaySeconds: true, expected: "2024-01-15T14:30:45Z" },
    ])("formats UTC timestamp (displaySeconds=$displaySeconds)", ({ displaySeconds, expected }) => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      const result = displaySeconds
        ? formatUtcTimestamp(date, { displaySeconds: true })
        : formatUtcTimestamp(date);
      expect(result).toBe(expected);
    });
  });

  describe("formatZonedTimestamp", () => {
    it.each([
      {
        date: new Date("2024-01-15T14:30:45.000Z"),
        options: { timeZone: "UTC", displaySeconds: true },
        expected: /2024-01-15 14:30:45/,
      },
      {
        date: new Date("2024-01-15T14:30:45.000Z"),
        options: { timeZone: "UTC", displayWeekday: true },
        expected: /^Mon 2024-01-15 14:30 UTC$/,
      },
    ] as const)("formats zoned timestamp", ({ date, options, expected }) => {
      const result = formatZonedTimestamp(date, options);
      expect(result).toMatch(expected);
    });

    it("follows host timezone changes while keeping explicit zones fixed", () => {
      const date = new Date("2024-01-15T14:30:00.000Z");
      for (const [timezone, expected] of [
        ["UTC", "2024-01-15 14:30 UTC"],
        ["America/New_York", "2024-01-15 09:30 EST"],
        ["UTC", "2024-01-15 14:30 UTC"],
      ]) {
        withEnv({ TZ: timezone }, () => {
          expect(formatZonedTimestamp(date)).toBe(expected);
          expect(formatZonedTimestamp(date, { timeZone: "UTC" })).toBe("2024-01-15 14:30 UTC");
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

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });

    it("returns undefined when Intl formatting throws", () => {
      vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
        throw new Error("boom");
      });

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });
  });
});

describe("format-relative", () => {
  describe("formatTimeAgo", () => {
    it("returns fallback for invalid elapsed input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatTimeAgo(value)).toBe("unknown");
      }
      expect(formatTimeAgo(null, { fallback: "n/a" })).toBe("n/a");
    });

    it("formats relative age around key unit boundaries", () => {
      expectFormatterCases(formatTimeAgo, [
        { input: 0, expected: "just now" },
        { input: 29000, expected: "just now" },
        { input: 30000, expected: "1m ago" },
        { input: 300000, expected: "5m ago" },
        { input: 7200000, expected: "2h ago" },
        { input: 47 * 3600000, expected: "47h ago" },
        { input: 48 * 3600000, expected: "2d ago" },
      ]);
    });

    it.each([
      { input: 0, expected: "0s" },
      { input: 7200000, expected: "2h" },
    ])("omits suffix for %j when disabled", ({ input, expected }) => {
      expect(formatTimeAgo(input, { suffix: false })).toBe(expected);
    });
  });

  describe("formatRelativeTimestamp", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-02-10T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns fallback for invalid timestamp input", () => {
      for (const value of [null, undefined]) {
        expect(formatRelativeTimestamp(value)).toBe("n/a");
      }
      expect(formatRelativeTimestamp(null, { fallback: "unknown" })).toBe("unknown");
    });

    it.each([
      { offsetMs: -30000, expected: "just now" },
      { offsetMs: 30000, expected: "in <1m" },
    ])("formats relative timestamp for offset $offsetMs", ({ offsetMs, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs)).toBe(expected);
    });

    it.each([
      {
        name: "keeps 7-day-old timestamps relative",
        offsetMs: -7 * 24 * 3600000,
        options: { dateFallback: true, timezone: "UTC" },
        expected: "7d ago",
      },
    ])("$name", ({ offsetMs, options, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs, options)).toBe(expected);
    });

    it.each([[8, "in 8d"]])(
      "falls back to relative days for %d-day offsets when date formatting throws",
      (days, expected) => {
        expect(
          formatRelativeTimestamp(Date.now() + days * 24 * 3600000, {
            dateFallback: true,
            timezone: "Invalid/Timezone",
          }),
        ).toBe(expected);
      },
    );
  });
});
