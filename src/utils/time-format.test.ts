import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatRelativeTime } from "./time-format";

describe("formatRelativeTime", () => {
  const MOCK_NOW = new Date("2024-02-15T12:00:00Z").getTime();
  let originalTZ: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MOCK_NOW);
    originalTZ = process.env.TZ;
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTZ) {
        process.env.TZ = originalTZ;
    } else {
        delete process.env.TZ;
    }
  });

  it('returns "just now" for less than 60 seconds', () => {
    // 0 seconds ago
    expect(formatRelativeTime(MOCK_NOW)).toBe("just now");
    // 30 seconds ago
    expect(formatRelativeTime(MOCK_NOW - 30 * 1000)).toBe("just now");
    // 59 seconds ago
    expect(formatRelativeTime(MOCK_NOW - 59 * 1000)).toBe("just now");
  });

  it('returns "just now" for future timestamps', () => {
    // 10 seconds in the future
    expect(formatRelativeTime(MOCK_NOW + 10 * 1000)).toBe("just now");
  });

  it('returns "Xm ago" for less than 60 minutes', () => {
    // 1 minute ago
    expect(formatRelativeTime(MOCK_NOW - 60 * 1000)).toBe("1m ago");
    // 5 minutes ago
    expect(formatRelativeTime(MOCK_NOW - 5 * 60 * 1000)).toBe("5m ago");
    // 59 minutes 59 seconds ago
    expect(formatRelativeTime(MOCK_NOW - (59 * 60 * 1000 + 59 * 1000))).toBe("59m ago");
  });

  it('returns "Xh ago" for less than 24 hours', () => {
    // 1 hour ago
    expect(formatRelativeTime(MOCK_NOW - 60 * 60 * 1000)).toBe("1h ago");
    // 2 hours ago
    expect(formatRelativeTime(MOCK_NOW - 2 * 60 * 60 * 1000)).toBe("2h ago");
    // 23 hours 59 minutes ago
    expect(formatRelativeTime(MOCK_NOW - (23 * 60 * 60 * 1000 + 59 * 60 * 1000))).toBe("23h ago");
  });

  it('returns "Yesterday" for 24 to 47 hours', () => {
    // 24 hours ago
    expect(formatRelativeTime(MOCK_NOW - 24 * 60 * 60 * 1000)).toBe("Yesterday");
    // 47 hours 59 minutes ago
    expect(formatRelativeTime(MOCK_NOW - (47 * 60 * 60 * 1000 + 59 * 60 * 1000))).toBe("Yesterday");
  });

  it('returns "Xd ago" for 2 to 6 days', () => {
    // 48 hours (2 days) ago
    expect(formatRelativeTime(MOCK_NOW - 48 * 60 * 60 * 1000)).toBe("2d ago");
    // 6 days ago
    expect(formatRelativeTime(MOCK_NOW - 6 * 24 * 60 * 60 * 1000)).toBe("6d ago");
    // 6 days 23 hours ago
    expect(formatRelativeTime(MOCK_NOW - (6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000))).toBe("6d ago");
  });

  it("returns formatted date for 7 days or more", () => {
    // 7 days ago -> Feb 8
    expect(formatRelativeTime(MOCK_NOW - 7 * 24 * 60 * 60 * 1000)).toBe("Feb 8");
    // 30 days ago -> Jan 16
    expect(formatRelativeTime(MOCK_NOW - 30 * 24 * 60 * 60 * 1000)).toBe("Jan 16");
  });
});
