import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./time-format.js";

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats past times", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(formatRelativeTime(now - 10_000)).toBe("just now");
    expect(formatRelativeTime(now - 2 * 60_000)).toBe("2m ago");
    expect(formatRelativeTime(now - 3 * 60 * 60_000)).toBe("3h ago");
    expect(formatRelativeTime(now - 24 * 60 * 60_000)).toBe("Yesterday");
  });

  it("formats future times", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(formatRelativeTime(now + 10_000)).toBe("in a moment");
    expect(formatRelativeTime(now + 2 * 60_000)).toBe("in 2m");
    expect(formatRelativeTime(now + 4 * 60 * 60_000)).toBe("in 4h");
    expect(formatRelativeTime(now + 24 * 60 * 60_000)).toBe("Tomorrow");
    expect(formatRelativeTime(now + 3 * 24 * 60 * 60_000)).toBe("in 3d");
  });
});
