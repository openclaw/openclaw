import { describe, expect, it } from "vitest";
import { formatElapsed } from "./cross-channel-context.js";

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
  it("returns 'just now' for timestamps less than 1 minute ago", () => {
    const now = new Date().toISOString();
    expect(formatElapsed(now)).toBe("just now");
  });

  it("returns minutes for timestamps < 60 minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatElapsed(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours and minutes for timestamps >= 60 minutes ago", () => {
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    expect(formatElapsed(ninetyMinAgo)).toBe("1h30m ago");
  });

  it("handles exactly 1 hour", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatElapsed(oneHourAgo)).toBe("1h0m ago");
  });

  it("handles multi-hour timestamps", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatElapsed(threeHoursAgo)).toBe("3h0m ago");
  });

  it("returns 'just now' for timestamp 30 seconds ago", () => {
    const thirtySecAgo = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatElapsed(thirtySecAgo)).toBe("just now");
  });

  it("returns '1m ago' for timestamp exactly 1 minute ago", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatElapsed(oneMinAgo)).toBe("1m ago");
  });
});
