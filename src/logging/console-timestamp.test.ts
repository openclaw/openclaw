import { describe, expect, it } from "vitest";
import { formatConsoleTimestamp } from "./console.js";

describe("formatConsoleTimestamp", () => {
  it("pretty style returns local HH:MM:SS", () => {
    const result = formatConsoleTimestamp("pretty");
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // Verify it uses local time, not UTC
    const now = new Date();
    const expectedHour = String(now.getHours()).padStart(2, "0");
    expect(result.slice(0, 2)).toBe(expectedHour);
  });

  it("compact style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("compact");
    // Should match: YYYY-MM-DDTHH:MM:SS.mmm+HH:MM or -HH:MM
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // Should NOT end with Z (UTC indicator)
    expect(result).not.toMatch(/Z$/);
  });

  it("json style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("json");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(result).not.toMatch(/Z$/);
  });

  it("timestamp contains the correct local date components", () => {
    const before = new Date();
    const result = formatConsoleTimestamp("compact");
    const after = new Date();
    // The date portion should match the local date
    const datePart = result.slice(0, 10);
    const beforeDate = `${before.getFullYear()}-${String(before.getMonth() + 1).padStart(2, "0")}-${String(before.getDate()).padStart(2, "0")}`;
    const afterDate = `${after.getFullYear()}-${String(after.getMonth() + 1).padStart(2, "0")}-${String(after.getDate()).padStart(2, "0")}`;
    // Allow for date boundary crossing during test
    expect([beforeDate, afterDate]).toContain(datePart);
  });
});
