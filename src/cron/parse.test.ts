import { describe, expect, it } from "vitest";

import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("returns null for empty or whitespace", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull();
    expect(parseAbsoluteTimeMs("   ")).toBeNull();
  });

  it("parses epoch milliseconds", () => {
    const ms = 1769871600000;
    expect(parseAbsoluteTimeMs(String(ms))).toBe(ms);
  });

  it("parses ISO date (UTC midnight)", () => {
    expect(parseAbsoluteTimeMs("2026-01-12")).toBe(Date.parse("2026-01-12T00:00:00Z"));
  });

  it("parses ISO datetime without TZ (coerced to UTC)", () => {
    expect(parseAbsoluteTimeMs("2026-01-12T18:00:00")).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("parses ISO datetime with Z", () => {
    expect(parseAbsoluteTimeMs("2026-01-12T18:00:00Z")).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("parses ISO datetime with offset", () => {
    expect(parseAbsoluteTimeMs("2026-02-01T23:00:00+08:00")).toBe(
      Date.parse("2026-02-01T15:00:00Z"),
    );
  });

  it("parses local time in IANA timezone when tz provided", () => {
    const ms = parseAbsoluteTimeMs("2026-02-01 23:00:00", "Asia/Shanghai");
    expect(ms).not.toBeNull();
    expect(new Date(ms!).toISOString()).toBe("2026-02-01T15:00:00.000Z");
  });

  it("parses local time with T separator when tz provided", () => {
    const ms = parseAbsoluteTimeMs("2026-02-01T23:00:00", "Asia/Shanghai");
    expect(ms).not.toBeNull();
    expect(new Date(ms!).toISOString()).toBe("2026-02-01T15:00:00.000Z");
  });

  it("ignores tz when string has explicit offset", () => {
    const ms = parseAbsoluteTimeMs("2026-02-01T23:00:00+08:00", "America/New_York");
    expect(ms).toBe(Date.parse("2026-02-01T15:00:00Z"));
  });

  it("returns null for invalid timezone", () => {
    expect(parseAbsoluteTimeMs("2026-02-01 23:00:00", "Invalid/Zone")).toBeNull();
  });

  it("returns null for date-only when tz provided (avoid silent UTC midnight)", () => {
    expect(parseAbsoluteTimeMs("2026-02-01", "Asia/Shanghai")).toBeNull();
  });
});
