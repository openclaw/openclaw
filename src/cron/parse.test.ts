import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("parses ISO-8601 datetime strings", () => {
    const result = parseAbsoluteTimeMs("2026-01-12T18:00:00Z");
    expect(result).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("parses ISO date-only strings as midnight UTC", () => {
    const result = parseAbsoluteTimeMs("2026-01-12");
    expect(result).toBe(Date.parse("2026-01-12T00:00:00Z"));
  });

  it("parses ISO datetime without timezone suffix as UTC", () => {
    const result = parseAbsoluteTimeMs("2026-01-12T18:00:00");
    expect(result).toBe(Date.parse("2026-01-12T18:00:00Z"));
  });

  it("parses millisecond epoch strings as-is", () => {
    // 1_714_000_000_000 ms = ~April 25, 2024
    const result = parseAbsoluteTimeMs("1714000000000");
    expect(result).toBe(1_714_000_000_000);
    expect(new Date(result!).getUTCFullYear()).toBe(2024);
  });

  it("auto-promotes Unix-seconds strings to milliseconds to fix year-58177 bug", () => {
    // 1_714_000_000 is April 25, 2024 in Unix seconds.
    // Without the fix, this would be treated as 1714000000 ms = Jan 20, 1970.
    // With the fix, it should be treated as 1714000000 * 1000 ms = Apr 25, 2024.
    const result = parseAbsoluteTimeMs("1714000000");
    expect(result).toBe(1_714_000_000 * 1000);
    expect(new Date(result!).getUTCFullYear()).toBe(2024);
  });

  it("auto-promotes 9-digit Unix-seconds timestamps", () => {
    // 999999999 seconds = ~Sep 9, 2001
    const result = parseAbsoluteTimeMs("999999999");
    expect(result).toBe(999_999_999 * 1000);
    expect(new Date(result!).getUTCFullYear()).toBe(2001);
  });

  it("does not multiply already-millisecond values above threshold", () => {
    // 1_000_000_000_000 ms = exactly the SECONDS_VS_MS_THRESHOLD, treated as ms
    const result = parseAbsoluteTimeMs("1000000000000");
    expect(result).toBe(1_000_000_000_000);
  });

  it("does not multiply timestamps clearly above the threshold", () => {
    const tsMs = Date.parse("2026-06-15T12:00:00Z");
    const result = parseAbsoluteTimeMs(String(tsMs));
    expect(result).toBe(tsMs);
    expect(new Date(result!).getUTCFullYear()).toBe(2026);
  });

  it("returns null for empty string", () => {
    expect(parseAbsoluteTimeMs("")).toBeNull();
    expect(parseAbsoluteTimeMs("  ")).toBeNull();
  });

  it("returns null for non-date strings", () => {
    expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
    expect(parseAbsoluteTimeMs("abc123")).toBeNull();
  });
});
