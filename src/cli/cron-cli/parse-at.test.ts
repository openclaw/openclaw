import { describe, expect, it } from "vitest";
import { parseAt } from "./shared.js";

function getDateTimeParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

describe("parseAt", () => {
  it("resolves HH:MM with --tz using today's date in that timezone", () => {
    const result = parseAt("09:00", "Asia/Shanghai");
    expect(result).not.toBeNull();

    const actual = getDateTimeParts(result!, "Asia/Shanghai");
    const today = getDateTimeParts(new Date().toISOString(), "Asia/Shanghai");

    expect(actual.year).toBe(today.year);
    expect(actual.month).toBe(today.month);
    expect(actual.day).toBe(today.day);
    expect(actual.hour).toBe("09");
    expect(actual.minute).toBe("00");
    expect(actual.second).toBe("00");
  });

  it("resolves HH:MM without --tz as a UTC wall-clock time for today", () => {
    const result = parseAt("09:00");
    expect(result).not.toBeNull();

    const actual = getDateTimeParts(result!, "UTC");
    const today = getDateTimeParts(new Date().toISOString(), "UTC");

    expect(actual.year).toBe(today.year);
    expect(actual.month).toBe(today.month);
    expect(actual.day).toBe(today.day);
    expect(actual.hour).toBe("09");
    expect(actual.minute).toBe("00");
    expect(actual.second).toBe("00");
  });

  it("resolves HH:MM:SS with seconds", () => {
    const result = parseAt("14:30:45", "UTC");
    expect(result).not.toBeNull();

    const actual = getDateTimeParts(result!, "UTC");
    expect(actual.hour).toBe("14");
    expect(actual.minute).toBe("30");
    expect(actual.second).toBe("45");
  });

  it("still resolves offset-less ISO datetime with --tz", () => {
    const result = parseAt("2030-01-01T09:00:00", "Asia/Shanghai");
    expect(result).toBe("2030-01-01T01:00:00.000Z");
  });

  it("still resolves relative duration strings", () => {
    const before = Date.now();
    const result = parseAt("30m");
    expect(result).not.toBeNull();

    const resolvedMs = new Date(result!).getTime();
    const after = Date.now();
    expect(resolvedMs).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
    expect(resolvedMs).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 100);
  });

  it("returns null for invalid input", () => {
    expect(parseAt("not-a-time")).toBeNull();
    expect(parseAt("")).toBeNull();
  });

  it("returns null instead of throwing for invalid IANA timezones", () => {
    expect(() => parseAt("09:00", "Bad/Zone")).not.toThrow();
    expect(parseAt("09:00", "Bad/Zone")).toBeNull();
    expect(parseAt("09:00", "Asia/Shanghaix")).toBeNull();
  });

  it.each([
    "24:00",
    "24:00:00",
    "12:60",
    "12:30:60",
    "99:99",
  ])("rejects out-of-range time-only input %s without --tz", (input) => {
    expect(parseAt(input)).toBeNull();
  });

  it.each([
    "24:00",
    "24:00:00",
    "12:60",
    "12:30:60",
    "99:99",
  ])("rejects out-of-range time-only input %s with --tz", (input) => {
    expect(parseAt(input, "Asia/Shanghai")).toBeNull();
  });
});
