// Cron parse tests cover CLI and config parsing for scheduled jobs.
import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  describe("epoch milliseconds", () => {
    it("parses positive epoch milliseconds", () => {
      expect(parseAbsoluteTimeMs("1700000000000")).toBe(1_700_000_000_000);
    });

    it("rejects digit-only timestamps outside the Date range", () => {
      expect(parseAbsoluteTimeMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    });

    it("rejects negative epoch milliseconds", () => {
      // Negative numbers don't match /^\d+$/ pattern, so they're parsed as dates
      // "-1000" is interpreted as a date string by Date.parse()
      // This tests that very old timestamps outside valid range are rejected
      expect(parseAbsoluteTimeMs("-8640000000000001")).toBeNull();
    });

    it("rejects non-numeric strings that look like numbers", () => {
      expect(parseAbsoluteTimeMs("123abc")).toBeNull();
    });
  });

  describe("ISO 8601 date only", () => {
    it("parses date only as midnight UTC", () => {
      expect(parseAbsoluteTimeMs("2024-01-15")).toBe(Date.parse("2024-01-15T00:00:00Z"));
    });
  });

  describe("ISO 8601 datetime without timezone", () => {
    it("parses datetime without timezone as UTC", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00")).toBe(Date.parse("2024-01-15T10:30:00Z"));
    });
  });

  describe("ISO 8601 with Z (UTC) timezone", () => {
    it("parses datetime with Z suffix", () => {
      const expected = Date.parse("2024-01-15T10:30:00Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00Z")).toBe(expected);
    });

    it("parses RFC 3339 lowercase t and z separators", () => {
      const expected = Date.parse("2024-01-15T10:30:00Z");
      expect(parseAbsoluteTimeMs("2024-01-15t10:30:00z")).toBe(expected);
    });

    it("parses datetime with milliseconds and Z", () => {
      const expected = Date.parse("2024-01-15T10:30:45.123Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123Z")).toBe(expected);
    });

    it("parses datetime with nanoseconds and Z (truncates to ms)", () => {
      const expected = Date.parse("2024-01-15T10:30:45.123Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123456789Z")).toBe(expected);
    });
  });

  describe("ISO 8601 with timezone offset (colon format)", () => {
    it("parses datetime with positive offset +HH:MM", () => {
      // UTC+8 (Beijing/Singapore)
      const expected = Date.parse("2024-01-15T10:30:00+08:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+08:00")).toBe(expected);
    });

    it("parses datetime with negative offset -HH:MM", () => {
      // UTC-5 (EST)
      const expected = Date.parse("2024-01-15T10:30:00-05:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00-05:00")).toBe(expected);
    });

    it("parses datetime with 45-minute offset +12:45", () => {
      // New Zealand Chatham Islands
      const expected = Date.parse("2024-01-15T10:30:00+12:45");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+12:45")).toBe(expected);
    });
  });

  describe("ISO 8601 with timezone offset (no colon format)", () => {
    it("parses datetime with positive offset +HHMM", () => {
      const expected = Date.parse("2024-01-15T10:30:00+0800");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+0800")).toBe(expected);
    });

    it("parses datetime with negative offset -HHMM", () => {
      const expected = Date.parse("2024-01-15T10:30:00-0500");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00-0500")).toBe(expected);
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expect(parseAbsoluteTimeMs("  1700000000000  ")).toBe(1_700_000_000_000);
      expect(parseAbsoluteTimeMs("  2024-01-15T10:30:00Z  ")).toBe(
        Date.parse("2024-01-15T10:30:00Z"),
      );
    });

    it("rejects strings with only whitespace", () => {
      expect(parseAbsoluteTimeMs("")).toBeNull();
      expect(parseAbsoluteTimeMs("   ")).toBeNull();
    });
  });

  describe("invalid formats", () => {
    it("rejects invalid date strings", () => {
      expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-13-40")).toBeNull();
      expect(parseAbsoluteTimeMs("invalid")).toBeNull();
    });

    it("rejects truly malformed date strings", () => {
      // JavaScript Date.parse is very lenient, so we test only truly invalid formats
      expect(parseAbsoluteTimeMs("24-01-15")).toBeNull(); // Two-digit year too ambiguous
      expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
      expect(parseAbsoluteTimeMs("")).toBeNull();
    });

    it("rejects non-padded ISO-like date formats", () => {
      expect(parseAbsoluteTimeMs("2024-1-15")).toBeNull();
    });

    it("rejects incomplete datetime strings", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10")).toBeNull();
    });

    it("rejects invalid timezone formats", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+8:00")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+080")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00GMT")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles leap year dates", () => {
      expect(parseAbsoluteTimeMs("2024-02-29T00:00:00Z")).toBe(Date.parse("2024-02-29T00:00:00Z"));
    });

    it.each([
      ["8640000000000000", 8_640_000_000_000_000],
      ["+275760-09-13T00:00:00.000Z", 8_640_000_000_000_000],
      ["-271821-04-20T00:00:00.000Z", -8_640_000_000_000_000],
      ["+275760-09-13T01:00:00+01:00", 8_640_000_000_000_000],
      ["-271821-04-19T23:00:00-01:00", -8_640_000_000_000_000],
      ["+275760-09-13T00:00:00.001+00:01", 8_639_999_999_940_001],
      ["-271821-04-19T23:59:59.999-00:01", -8_639_999_999_940_001],
      ["-271821-04-19T24:00:00Z", -8_640_000_000_000_000],
      ["+275760-09-13T00:00:00.001Z", null],
      ["+275760-09-13T01:00:00.001+01:00", null],
      ["-271821-04-19T22:59:59.999-01:00", null],
      ["-000000-01-01", null],
    ] as const)(
      "applies Date bounds after offset and end-of-day conversion for %s",
      (input, expected) => {
        expect(parseAbsoluteTimeMs(input)).toBe(expected);
      },
    );
  });

  it.each([
    ["2027-02-28T24:00:00", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28T24:00:00Z", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28T24:00:00.000", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28T24:00:00.0000Z", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28T24:00:00+05:45", "2027-02-28T18:15:00.000Z"],
    ["2027-02-28t24:00", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00.000z", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00+05:45", "2027-02-28T18:15:00.000Z"],
  ])("preserves shipped ISO end-of-day timestamp %s", (input, expected) => {
    expect(parseAbsoluteTimeMs(input)).toBe(Date.parse(expected));
  });

  it.each([
    "2027-02-28T24:01:00Z",
    "2027-02-28t24:01z",
    "2027-02-28T24:00:01Z",
    "2027-02-28T24:00:00.001Z",
    "2027-02-28t24:00:00.001z",
    "2027-02-28T24:00:00.0001Z",
    "2027-02-29T24:00:00Z",
  ])("rejects invalid end-of-day timestamp %s", (input) => {
    expect(parseAbsoluteTimeMs(input)).toBeNull();
  });

  it.each([
    "2023-02-29",
    "2026-02-31",
    "2026-02-31T00:00:00Z",
    "2026-04-31T12:34:56Z",
    "2026-01-01T25:00:00Z",
    "December 17, 2026 03:24:00",
    "2026/12/17",
  ])("rejects invalid absolute timestamp %s", (input) => {
    expect(parseAbsoluteTimeMs(input)).toBeNull();
  });
});
