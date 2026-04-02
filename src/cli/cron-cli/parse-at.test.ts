import { describe, expect, it } from "vitest";
import { parseAt } from "./shared.js";

describe("parseAt — time-only strings (HH:MM / HH:MM:SS)", () => {
  it("resolves HH:MM with --tz to a UTC ISO string on the correct wall-clock day", () => {
    const result = parseAt("09:00", "Asia/Shanghai");
    expect(result).not.toBeNull();
    // Should be a valid ISO string
    expect(() => new Date(result!)).not.toThrow();
    // The UTC hour should be 01 (09:00 CST = 01:00 UTC)
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(1);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("resolves HH:MM without --tz to a UTC ISO string treated as UTC time", () => {
    const result = parseAt("09:00");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it("resolves HH:MM:SS with seconds", () => {
    const result = parseAt("14:30:45", "UTC");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(14);
    expect(d.getUTCMinutes()).toBe(30);
    expect(d.getUTCSeconds()).toBe(45);
  });

  it("still resolves offset-less ISO datetime with --tz", () => {
    const result = parseAt("2030-01-01T09:00:00", "Asia/Shanghai");
    expect(result).not.toBeNull();
    // 09:00 CST = 01:00 UTC
    const d = new Date(result!);
    expect(d.getUTCHours()).toBe(1);
  });

  it("still resolves relative duration strings", () => {
    const before = Date.now();
    const result = parseAt("30m");
    expect(result).not.toBeNull();
    const after = Date.now();
    const d = new Date(result!).getTime();
    expect(d).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 100);
    expect(d).toBeLessThanOrEqual(after + 30 * 60 * 1000 + 100);
  });

  it("returns null for invalid input", () => {
    expect(parseAt("not-a-time")).toBeNull();
    expect(parseAt("")).toBeNull();
  });

  it("returns null (not throws) when --tz is an invalid IANA timezone", () => {
    // Regression: previously Intl.DateTimeFormat threw a RangeError on bad
    // timezone, breaking parseAt's contract of returning null on bad input.
    expect(() => parseAt("09:00", "Bad/Zone")).not.toThrow();
    expect(parseAt("09:00", "Bad/Zone")).toBeNull();
    expect(parseAt("09:00", "Asia/Shanghaix")).toBeNull();
  });

  it("result date is today\'s wall-clock date in the given timezone", () => {
    const result = parseAt("09:00", "Asia/Shanghai");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    // Get today\'s date string in Shanghai (YYYY-MM-DD)
    const todayInSH = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(new Date())
      .replaceAll("/", "-");
    // The UTC ISO string should start with the correct Shanghai date
    // (allowing for the -8h UTC offset so day may appear as prev day in UTC)
    const utcIso = d.toISOString().slice(0, 10);
    const shDateMs = new Date(`${todayInSH}T09:00:00+08:00`).getTime();
    expect(Math.abs(d.getTime() - shDateMs)).toBeLessThan(1000);
    void utcIso; // used for debugging context only
  });
});
