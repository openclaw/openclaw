import { describe, expect, it } from "vitest";
import { formatIsoInTimezone, formatLocalIsoWithOffset } from "./timestamps.js";

function buildFakeDate(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  timezoneOffsetMinutes: number;
}): Date {
  return {
    getFullYear: () => parts.year,
    getMonth: () => parts.month - 1,
    getDate: () => parts.day,
    getHours: () => parts.hour,
    getMinutes: () => parts.minute,
    getSeconds: () => parts.second,
    getMilliseconds: () => parts.millisecond,
    getTimezoneOffset: () => parts.timezoneOffsetMinutes,
  } as unknown as Date;
}

describe("formatLocalIsoWithOffset", () => {
  it("formats positive offset with millisecond padding", () => {
    const value = formatLocalIsoWithOffset(
      buildFakeDate({
        year: 2026,
        month: 1,
        day: 2,
        hour: 3,
        minute: 4,
        second: 5,
        millisecond: 6,
        timezoneOffsetMinutes: -150, // UTC+02:30
      }),
    );
    expect(value).toBe("2026-01-02T03:04:05.006+02:30");
  });

  it("formats negative offset", () => {
    const value = formatLocalIsoWithOffset(
      buildFakeDate({
        year: 2026,
        month: 12,
        day: 31,
        hour: 23,
        minute: 59,
        second: 58,
        millisecond: 321,
        timezoneOffsetMinutes: 300, // UTC-05:00
      }),
    );
    expect(value).toBe("2026-12-31T23:59:58.321-05:00");
  });
});

describe("formatIsoInTimezone", () => {
  it("formats with a valid IANA timezone", () => {
    // Use a fixed UTC date so we know the expected offset
    const utcDate = new Date("2026-06-15T18:30:45.123Z");
    const result = formatIsoInTimezone(utcDate, "America/New_York");
    // EDT = UTC-4 in June
    expect(result).toBe("2026-06-15T14:30:45.123-04:00");
  });

  it("formats with a positive-offset timezone", () => {
    const utcDate = new Date("2026-01-15T08:00:00.500Z");
    const result = formatIsoInTimezone(utcDate, "Asia/Tokyo");
    // JST = UTC+9
    expect(result).toBe("2026-01-15T17:00:00.500+09:00");
  });

  it("preserves millisecond precision", () => {
    const utcDate = new Date("2026-03-10T12:00:00.007Z");
    const result = formatIsoInTimezone(utcDate, "UTC");
    expect(result).toBe("2026-03-10T12:00:00.007+00:00");
  });

  it("uses offset notation not abbreviation", () => {
    const utcDate = new Date("2026-01-15T12:00:00.000Z");
    const result = formatIsoInTimezone(utcDate, "America/New_York");
    // Should have -05:00 not EST
    expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(result).not.toMatch(/[A-Z]{2,4}$/);
  });

  it("falls back to system local when timezone is invalid", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    const result = formatIsoInTimezone(date, "Not/A/Real/Zone");
    // Should still produce valid ISO 8601 with offset
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("falls back to system local when timezone is undefined", () => {
    const date = new Date("2026-01-15T12:00:00.000Z");
    const result = formatIsoInTimezone(date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it("handles DST boundary correctly (spring forward)", () => {
    // 2026-03-08 2:00 AM ET → clocks spring forward to 3:00 AM
    // At UTC 06:30 on March 8, it should be 1:30 AM EST (before spring forward)
    const beforeDst = new Date("2026-03-08T06:30:00.000Z");
    const result = formatIsoInTimezone(beforeDst, "America/New_York");
    expect(result).toBe("2026-03-08T01:30:00.000-05:00");

    // At UTC 07:30 on March 8, it should be 3:30 AM EDT (after spring forward)
    const afterDst = new Date("2026-03-08T07:30:00.000Z");
    const result2 = formatIsoInTimezone(afterDst, "America/New_York");
    expect(result2).toBe("2026-03-08T03:30:00.000-04:00");
  });

  it("handles DST boundary correctly (fall back)", () => {
    // 2026-11-01 2:00 AM ET → clocks fall back to 1:00 AM
    // At UTC 05:30 on Nov 1, it should be 1:30 AM EDT (before fall back)
    const beforeFallback = new Date("2026-11-01T05:30:00.000Z");
    const result = formatIsoInTimezone(beforeFallback, "America/New_York");
    expect(result).toBe("2026-11-01T01:30:00.000-04:00");

    // At UTC 06:30 on Nov 1, it should be 1:30 AM EST (after fall back)
    const afterFallback = new Date("2026-11-01T06:30:00.000Z");
    const result2 = formatIsoInTimezone(afterFallback, "America/New_York");
    expect(result2).toBe("2026-11-01T01:30:00.000-05:00");
  });
});
