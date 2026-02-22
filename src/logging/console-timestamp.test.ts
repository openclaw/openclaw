import { afterEach, describe, expect, it, vi } from "vitest";
import { formatConsoleTimestamp } from "./timestamps.js";

describe("formatConsoleTimestamp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function pad2(n: number) {
    return String(n).padStart(2, "0");
  }

  function pad3(n: number) {
    return String(n).padStart(3, "0");
  }

  function formatExpectedLocalIsoWithOffset(now: Date) {
    const year = now.getFullYear();
    const month = pad2(now.getMonth() + 1);
    const day = pad2(now.getDate());
    const h = pad2(now.getHours());
    const m = pad2(now.getMinutes());
    const s = pad2(now.getSeconds());
    const ms = pad3(now.getMilliseconds());
    const tzOffset = now.getTimezoneOffset();
    const tzSign = tzOffset <= 0 ? "+" : "-";
    const tzHours = pad2(Math.floor(Math.abs(tzOffset) / 60));
    const tzMinutes = pad2(Math.abs(tzOffset) % 60);
    return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${tzSign}${tzHours}:${tzMinutes}`;
  }

  it("pretty style returns local HH:MM:SS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));

    const result = formatConsoleTimestamp("pretty");
    const now = new Date();
    expect(result).toBe(
      `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
    );
  });

  it("compact style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("compact");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));
    const now = new Date();
    expect(formatConsoleTimestamp("compact")).toBe(formatExpectedLocalIsoWithOffset(now));
  });

  it("json style returns local ISO-like timestamp with timezone offset", () => {
    const result = formatConsoleTimestamp("json");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));
    const now = new Date();
    expect(formatConsoleTimestamp("json")).toBe(formatExpectedLocalIsoWithOffset(now));
  });

  it("timestamp contains the correct local date components", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));

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

  describe("with timezone", () => {
    it("pretty style respects timezone", () => {
      vi.useFakeTimers();
      const date = new Date("2023-10-27T10:00:00.123Z");
      vi.setSystemTime(date);

      // UTC
      expect(formatConsoleTimestamp("pretty", "UTC")).toBe("10:00:00");

      // NYC (UTC-4 in Oct)
      expect(formatConsoleTimestamp("pretty", "America/New_York")).toBe("06:00:00");

      // Kolkata (UTC+5:30)
      expect(formatConsoleTimestamp("pretty", "Asia/Kolkata")).toBe("15:30:00");
    });

    it("compact style respects timezone", () => {
      vi.useFakeTimers();
      const date = new Date("2023-10-27T10:00:00.123Z");
      vi.setSystemTime(date);

      // UTC
      // 2023-10-27T10:00:00.123+00:00
      expect(formatConsoleTimestamp("compact", "UTC")).toBe("2023-10-27T10:00:00.123+00:00");

      // NYC
      // 2023-10-27T06:00:00.123-04:00
      expect(formatConsoleTimestamp("compact", "America/New_York")).toBe(
        "2023-10-27T06:00:00.123-04:00",
      );
    });

    it("falls back to local time on invalid timezone without crashing", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-17T18:01:02.345Z"));

      // Should not throw or log recursive error
      // We can't easily check for console.error calls if we don't spy on it,
      // but the requirement is "falls back".
      // The implementation catches error and falls back to:
      // formatLocalIsoWithOffset(now) -> uses system local time.

      const result = formatConsoleTimestamp("pretty", "Invalid/Timezone");
      const now = new Date();
      // Should match local pretty time
      expect(result).toBe(
        `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
      );
    });
  });
});
