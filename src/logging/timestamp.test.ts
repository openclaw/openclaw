import { describe, expect, it } from "vitest";
import { formatLocalIso, localDateStr, localTimeStr, tzOffsetLabel } from "./timestamp.js";

describe("formatLocalIso", () => {
  it("formats a fixed date in local ISO-8601 with ms and tz offset", () => {
    // 2026-06-15T10:30:45.123Z — use a fixed date
    const d = new Date(2026, 5, 15, 10, 30, 45, 123); // local time
    const result = formatLocalIso(d);

    // Should start with local date/time
    expect(result).toMatch(/^2026-06-15T10:30:45\.123[+-]\d{2}:\d{2}$/);
  });

  it("pads single-digit months/days/hours/minutes/seconds", () => {
    const d = new Date(2026, 0, 5, 3, 7, 9, 4); // Jan 5, 03:07:09.004
    const result = formatLocalIso(d);

    expect(result).toMatch(/^2026-01-05T03:07:09\.004[+-]\d{2}:\d{2}$/);
  });

  it("uses current time when no argument is passed", () => {
    const before = Date.now();
    const result = formatLocalIso();
    const after = Date.now();

    // Parse the result back and verify it's within the time window
    const parsed = new Date(result);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.getTime()).toBeLessThanOrEqual(after + 1);
  });

  it("produces a string parseable by new Date()", () => {
    const original = new Date(2026, 7, 20, 14, 0, 0, 500);
    const iso = formatLocalIso(original);
    const reparsed = new Date(iso);

    expect(reparsed.getTime()).toBe(original.getTime());
  });

  it("never ends with Z", () => {
    const result = formatLocalIso(new Date());
    expect(result).not.toMatch(/Z$/);
    expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});

describe("localDateStr", () => {
  it("returns YYYY-MM-DD from a local date", () => {
    const d = new Date(2026, 11, 3, 23, 59, 59); // Dec 3
    expect(localDateStr(d)).toBe("2026-12-03");
  });

  it("pads month and day", () => {
    const d = new Date(2026, 0, 1); // Jan 1
    expect(localDateStr(d)).toBe("2026-01-01");
  });
});

describe("localTimeStr", () => {
  it("returns HH:MM:SS from a local date", () => {
    const d = new Date(2026, 0, 1, 14, 5, 9);
    expect(localTimeStr(d)).toBe("14:05:09");
  });

  it("handles midnight", () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(localTimeStr(d)).toBe("00:00:00");
  });
});

describe("tzOffsetLabel", () => {
  it("returns a ±HH:MM string", () => {
    const result = tzOffsetLabel(new Date());
    expect(result).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("matches the offset in formatLocalIso", () => {
    const d = new Date();
    const iso = formatLocalIso(d);
    const label = tzOffsetLabel(d);

    // The last 6 chars of formatLocalIso should be the tz offset
    expect(iso.slice(-6)).toBe(label);
  });
});
