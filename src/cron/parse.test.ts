// Cron parse tests cover CLI and config parsing for scheduled jobs.
import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  describe("epoch milliseconds", () => {
    it("rejects digit-only timestamps outside the Date range", () => {
      expect(parseAbsoluteTimeMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expect(parseAbsoluteTimeMs("  1700000000000  ")).toBe(1_700_000_000_000);
      expect(parseAbsoluteTimeMs("  2024-01-15T10:30:00Z  ")).toBe(
        Date.parse("2024-01-15T10:30:00Z"),
      );
    });
  });

  describe("invalid formats", () => {
    it("rejects truly malformed date strings", () => {
      // JavaScript Date.parse is very lenient, so we test only truly invalid formats
      expect(parseAbsoluteTimeMs("24-01-15")).toBeNull(); // Two-digit year too ambiguous
      expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
      expect(parseAbsoluteTimeMs("")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it.each([["+275760-09-13T01:00:00.001+01:00", null]] as const)(
      "applies Date bounds after offset and end-of-day conversion for %s",
      (input, expected) => {
        expect(parseAbsoluteTimeMs(input)).toBe(expected);
      },
    );
  });

  it.each([
    ["2027-02-28t24:00:00.000z", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00+05:45", "2027-02-28T18:15:00.000Z"],
  ])("preserves shipped ISO end-of-day timestamp %s", (input, expected) => {
    expect(parseAbsoluteTimeMs(input)).toBe(Date.parse(expected));
  });
});
