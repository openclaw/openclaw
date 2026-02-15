import { describe, expect, it } from "vitest";
import { formatUtcTimestamp, formatZonedTimestamp, resolveTimezone } from "./format-datetime.js";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatDurationPrecise,
  formatDurationSeconds,
} from "./format-duration.js";
import { formatTimeAgo, formatRelativeTimestamp } from "./format-relative.js";

describe("format-duration", () => {
  describe("formatDurationCompact", () => {
    it("returns undefined for null/undefined/non-positive", () => {
      expect(formatDurationCompact(null)).toBeUndefined();
      expect(formatDurationCompact(undefined)).toBeUndefined();
      expect(formatDurationCompact(0)).toBeUndefined();
      expect(formatDurationCompact(-100)).toBeUndefined();
    });

    it("formats milliseconds for sub-second durations", () => {
      expect(formatDurationCompact(500)).toBe("500ms");
      expect(formatDurationCompact(999)).toBe("999ms");
    });

    it("formats seconds", () => {
      expect(formatDurationCompact(1000)).toBe("1s");
      expect(formatDurationCompact(45000)).toBe("45s");
      expect(formatDurationCompact(59000)).toBe("59s");
    });

    it("formats minutes and seconds", () => {
      expect(formatDurationCompact(60000)).toBe("1m");
      expect(formatDurationCompact(65000)).toBe("1m5s");
      expect(formatDurationCompact(90000)).toBe("1m30s");
    });

    it("omits trailing zero components", () => {
      expect(formatDurationCompact(60000)).toBe("1m"); // not "1m0s"
      expect(formatDurationCompact(3600000)).toBe("1h"); // not "1h0m"
      expect(formatDurationCompact(86400000)).toBe("1d"); // not "1d0h"
    });

    it("formats hours and minutes", () => {
      expect(formatDurationCompact(3660000)).toBe("1h1m");
      expect(formatDurationCompact(5400000)).toBe("1h30m");
    });

    it("formats days and hours", () => {
      expect(formatDurationCompact(90000000)).toBe("1d1h");
      expect(formatDurationCompact(172800000)).toBe("2d");
    });

    it("supports spaced option", () => {
      expect(formatDurationCompact(65000, { spaced: true })).toBe("1m 5s");
      expect(formatDurationCompact(3660000, { spaced: true })).toBe("1h 1m");
      expect(formatDurationCompact(90000000, { spaced: true })).toBe("1d 1h");
    });

    it("rounds at boundaries", () => {
      // 59.5 seconds rounds to 60s = 1m
      expect(formatDurationCompact(59500)).toBe("1m");
      // 59.4 seconds rounds to 59s
      expect(formatDurationCompact(59400)).toBe("59s");
    });
  });

  describe("formatDurationHuman", () => {
    it("returns fallback for invalid input", () => {
      expect(formatDurationHuman(null)).toBe("n/a");
      expect(formatDurationHuman(undefined)).toBe("n/a");
      expect(formatDurationHuman(-100)).toBe("n/a");
      expect(formatDurationHuman(null, "unknown")).toBe("unknown");
    });

    it("formats single unit", () => {
      expect(formatDurationHuman(500)).toBe("500ms");
      expect(formatDurationHuman(5000)).toBe("5s");
      expect(formatDurationHuman(180000)).toBe("3m");
      expect(formatDurationHuman(7200000)).toBe("2h");
      expect(formatDurationHuman(172800000)).toBe("2d");
    });

    it("uses 24h threshold for days", () => {
      expect(formatDurationHuman(23 * 3600000)).toBe("23h");
      expect(formatDurationHuman(24 * 3600000)).toBe("1d");
      expect(formatDurationHuman(25 * 3600000)).toBe("1d"); // rounds
    });
  });

  describe("formatDurationPrecise", () => {
    it("shows milliseconds for sub-second", () => {
      expect(formatDurationPrecise(500)).toBe("500ms");
      expect(formatDurationPrecise(999)).toBe("999ms");
    });

    it("shows decimal seconds for >=1s", () => {
      expect(formatDurationPrecise(1000)).toBe("1s");
      expect(formatDurationPrecise(1500)).toBe("1.5s");
      expect(formatDurationPrecise(1234)).toBe("1.23s");
    });

    it("returns unknown for non-finite", () => {
      expect(formatDurationPrecise(NaN)).toBe("unknown");
      expect(formatDurationPrecise(Infinity)).toBe("unknown");
    });
  });

  describe("formatDurationSeconds", () => {
    it("formats with configurable decimals", () => {
      expect(formatDurationSeconds(1500, { decimals: 1 })).toBe("1.5s");
      expect(formatDurationSeconds(1234, { decimals: 2 })).toBe("1.23s");
      expect(formatDurationSeconds(1000, { decimals: 0 })).toBe("1s");
    });

    it("supports seconds unit", () => {
      expect(formatDurationSeconds(2000, { unit: "seconds" })).toBe("2 seconds");
    });
  });
});

describe("format-datetime", () => {
  describe("resolveTimezone", () => {
    it("returns valid IANA timezone strings", () => {
      expect(resolveTimezone("America/New_York")).toBe("America/New_York");
      expect(resolveTimezone("Europe/London")).toBe("Europe/London");
      expect(resolveTimezone("UTC")).toBe("UTC");
    });

    it("returns undefined for invalid timezones", () => {
      expect(resolveTimezone("Invalid/Timezone")).toBeUndefined();
      expect(resolveTimezone("garbage")).toBeUndefined();
      expect(resolveTimezone("")).toBeUndefined();
    });
  });

  describe("formatUtcTimestamp", () => {
    it("formats without seconds by default", () => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      expect(formatUtcTimestamp(date)).toBe("2024-01-15T14:30Z");
    });

    it("includes seconds when requested", () => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      expect(formatUtcTimestamp(date, { displaySeconds: true })).toBe("2024-01-15T14:30:45Z");
    });
  });

  describe("formatZonedTimestamp", () => {
    it("formats with timezone abbreviation", () => {
      const date = new Date("2024-01-15T14:30:00.000Z");
      const result = formatZonedTimestamp(date, { timeZone: "UTC" });
      expect(result).toMatch(/2024-01-15 14:30/);
    });

    it("includes seconds when requested", () => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      const result = formatZonedTimestamp(date, { timeZone: "UTC", displaySeconds: true });
      expect(result).toMatch(/2024-01-15 14:30:45/);
    });
  });
});

describe("format-relative", () => {
  describe("formatTimeAgo", () => {
    it("returns fallback for invalid input", () => {
      expect(formatTimeAgo(null)).toBe("unknown");
      expect(formatTimeAgo(undefined)).toBe("unknown");
      expect(formatTimeAgo(-100)).toBe("unknown");
      expect(formatTimeAgo(null, { fallback: "n/a" })).toBe("n/a");
    });

    it("formats with 'ago' suffix by default", () => {
      expect(formatTimeAgo(0)).toBe("just now");
      expect(formatTimeAgo(29000)).toBe("just now"); // rounds to <1m
      expect(formatTimeAgo(30000)).toBe("1m ago"); // 30s rounds to 1m
      expect(formatTimeAgo(300000)).toBe("5m ago");
      expect(formatTimeAgo(7200000)).toBe("2h ago");
      expect(formatTimeAgo(172800000)).toBe("2d ago");
    });

    it("omits suffix when suffix: false", () => {
      expect(formatTimeAgo(0, { suffix: false })).toBe("0s");
      expect(formatTimeAgo(300000, { suffix: false })).toBe("5m");
      expect(formatTimeAgo(7200000, { suffix: false })).toBe("2h");
    });

    it("uses 48h threshold before switching to days", () => {
      expect(formatTimeAgo(47 * 3600000)).toBe("47h ago");
      expect(formatTimeAgo(48 * 3600000)).toBe("2d ago");
    });
  });

  describe("formatRelativeTimestamp", () => {
    it("returns fallback for invalid input", () => {
      expect(formatRelativeTimestamp(null)).toBe("n/a");
      expect(formatRelativeTimestamp(undefined)).toBe("n/a");
      expect(formatRelativeTimestamp(null, { fallback: "unknown" })).toBe("unknown");
    });

    it("formats past timestamps", () => {
      const now = Date.now();
      expect(formatRelativeTimestamp(now - 10000)).toBe("just now");
      expect(formatRelativeTimestamp(now - 300000)).toBe("5m ago");
      expect(formatRelativeTimestamp(now - 7200000)).toBe("2h ago");
    });

    it("formats future timestamps", () => {
      const now = Date.now();
      expect(formatRelativeTimestamp(now + 30000)).toBe("in <1m");
      expect(formatRelativeTimestamp(now + 300000)).toBe("in 5m");
      expect(formatRelativeTimestamp(now + 7200000)).toBe("in 2h");
    });

    it("falls back to date for old timestamps when enabled", () => {
      const oldDate = Date.now() - 30 * 24 * 3600000; // 30 days ago
      const result = formatRelativeTimestamp(oldDate, { dateFallback: true });
      // Should be a short date like "Jan 9" not "30d ago"
      expect(result).toMatch(/[A-Z][a-z]{2} \d{1,2}/);
    });
  });
});
