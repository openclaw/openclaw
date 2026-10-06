// Timestamp tests cover timestamp formatting and timezone fallback behavior.
import { describe, expect, it } from "vitest";
import { formatDiagnosticFilenameTimestamp, formatTimestamp } from "./timestamps.js";

describe("formatDiagnosticFilenameTimestamp", () => {
  it("formats an ISO timestamp for filenames", () => {
    expect(formatDiagnosticFilenameTimestamp(new Date("2024-01-15T14:30:45.123Z"))).toBe(
      "2024-01-15T14-30-45-123Z",
    );
  });
});

describe("formatTimestamp", () => {
  const testDate = new Date("2024-01-15T14:30:45.123Z");

  it("formats short style with explicit UTC offset", () => {
    expect(formatTimestamp(testDate, { style: "short", timeZone: "UTC" })).toBe("14:30:45+00:00");
  });

  it("formats medium style with milliseconds and offset", () => {
    expect(formatTimestamp(testDate, { style: "medium", timeZone: "UTC" })).toBe(
      "14:30:45.123+00:00",
    );
  });

  it.each([
    ["UTC", "2024-01-15T14:30:45.123+00:00"],
    ["America/New_York", "2024-01-15T09:30:45.123-05:00"],
    ["Europe/Paris", "2024-01-15T15:30:45.123+01:00"],
  ])("formats long style in %s", (timeZone, expected) => {
    expect(formatTimestamp(testDate, { style: "long", timeZone })).toBe(expected);
  });

  it("keeps milliseconds and calendar boundaries fresh across consecutive timestamps", () => {
    for (const [time, timeZone, expected] of [
      ["1969-12-31T23:59:59.001Z", "UTC", "1969-12-31T23:59:59.001+00:00"],
      ["1969-12-31T23:59:59.999Z", "UTC", "1969-12-31T23:59:59.999+00:00"],
      ["1970-01-01T00:00:00.000Z", "UTC", "1970-01-01T00:00:00.000+00:00"],
      ["2024-03-10T06:59:59.999Z", "America/New_York", "2024-03-10T01:59:59.999-05:00"],
      ["2024-03-10T07:00:00.000Z", "America/New_York", "2024-03-10T03:00:00.000-04:00"],
      ["2024-03-10T07:00:00.123Z", "America/New_York", "2024-03-10T03:00:00.123-04:00"],
      ["2024-03-10T07:00:00.123Z", "UTC", "2024-03-10T07:00:00.123+00:00"],
      ["2024-03-10T07:00:00.123Z", "America/New_York", "2024-03-10T03:00:00.123-04:00"],
      ["2024-03-10T06:59:59.999Z", "America/New_York", "2024-03-10T01:59:59.999-05:00"],
    ] as const) {
      expect(formatTimestamp(new Date(time), { style: "long", timeZone })).toBe(expected);
    }
    expect(() => formatTimestamp(new Date(Number.NaN), { timeZone: "America/New_York" })).toThrow(
      RangeError,
    );
  });

  it("falls back to a valid offset when the timezone is invalid", () => {
    expect(formatTimestamp(testDate, { style: "short", timeZone: "not-a-tz" })).toMatch(
      /^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});
