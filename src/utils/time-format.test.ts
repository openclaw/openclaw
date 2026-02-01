import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { formatRelativeTime } from "./time-format.js";

describe("time-format", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for times under 60 seconds", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 1000)).toBe("just now");
    expect(formatRelativeTime(now - 59000)).toBe("just now");
  });

  it("returns minutes ago for times under an hour", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60 * 1000)).toBe("1m ago");
    expect(formatRelativeTime(now - 59 * 60 * 1000)).toBe("59m ago");
  });

  it("returns hours ago for times under 24 hours", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60 * 60 * 1000)).toBe("1h ago");
    expect(formatRelativeTime(now - 23 * 60 * 60 * 1000)).toBe("23h ago");
  });

  it("returns 'Yesterday' for 1 day ago", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 24 * 60 * 60 * 1000)).toBe("Yesterday");
    // Edge case: 47 hours is still "Yesterday" logic-wise here (days=1)
    expect(formatRelativeTime(now - 47 * 60 * 60 * 1000)).toBe("Yesterday");
  });

  it("returns days ago for times under a week", () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 48 * 60 * 60 * 1000)).toBe("2d ago");
    expect(formatRelativeTime(now - 6 * 24 * 60 * 60 * 1000)).toBe("6d ago");
  });

  it("returns formatted date for older times", () => {
    const now = new Date("2024-01-01T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const oldTime = new Date("2023-12-01T12:00:00Z").getTime(); // 31 days ago
    // Locale format depends on env, but we check partial match or stability
    const result = formatRelativeTime(oldTime);
    expect(result).toMatch(/Dec 1|1\/12|12\/1/);
  });
});
