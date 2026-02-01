import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./time-format.js";

describe("formatRelativeTime", () => {
  describe("just now", () => {
    it("returns 'just now' for current time", () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe("just now");
    });

    it("returns 'just now' for 30 seconds ago", () => {
      const timestamp = Date.now() - 30 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("just now");
    });

    it("returns 'just now' for 59 seconds ago", () => {
      const timestamp = Date.now() - 59 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("just now");
    });
  });

  describe("minutes ago", () => {
    it("returns '1m ago' for 1 minute ago", () => {
      const timestamp = Date.now() - 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("1m ago");
    });

    it("returns '5m ago' for 5 minutes ago", () => {
      const timestamp = Date.now() - 5 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("5m ago");
    });

    it("returns '59m ago' for 59 minutes ago", () => {
      const timestamp = Date.now() - 59 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("59m ago");
    });
  });

  describe("hours ago", () => {
    it("returns '1h ago' for 1 hour ago", () => {
      const timestamp = Date.now() - 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("1h ago");
    });

    it("returns '12h ago' for 12 hours ago", () => {
      const timestamp = Date.now() - 12 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("12h ago");
    });

    it("returns '23h ago' for 23 hours ago", () => {
      const timestamp = Date.now() - 23 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("23h ago");
    });
  });

  describe("days ago", () => {
    it("returns 'Yesterday' for 1 day ago", () => {
      const timestamp = Date.now() - 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("Yesterday");
    });

    it("returns 'Yesterday' for 1.5 days ago", () => {
      const timestamp = Date.now() - 1.5 * 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("Yesterday");
    });

    it("returns '2d ago' for 2 days ago", () => {
      const timestamp = Date.now() - 2 * 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("2d ago");
    });

    it("returns '6d ago' for 6 days ago", () => {
      const timestamp = Date.now() - 6 * 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("6d ago");
    });
  });

  describe("date format", () => {
    it("returns formatted date for 7 days ago", () => {
      const timestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const result = formatRelativeTime(timestamp);
      // Should not be a relative time string
      expect(result).not.toMatch(/^(just now|\d+m ago|\d+h ago|Yesterday|\d+d ago)$/);
      // Should be a date string (contains at least month and day)
      expect(result).toMatch(/[A-Za-z]+.*\d+/);
    });

    it("returns formatted date for 30 days ago", () => {
      const timestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const result = formatRelativeTime(timestamp);
      expect(result).not.toMatch(/^(just now|\d+m ago|\d+h ago|Yesterday|\d+d ago)$/);
      expect(result).toMatch(/[A-Za-z]+.*\d+/);
    });

    it("returns formatted date for 365 days ago", () => {
      const timestamp = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const result = formatRelativeTime(timestamp);
      expect(result).not.toMatch(/^(just now|\d+m ago|\d+h ago|Yesterday|\d+d ago)$/);
      expect(result).toMatch(/[A-Za-z]+.*\d+/);
    });
  });

  describe("boundary conditions", () => {
    it("handles timestamp at exactly 60 seconds", () => {
      const timestamp = Date.now() - 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("1m ago");
    });

    it("handles timestamp at exactly 60 minutes", () => {
      const timestamp = Date.now() - 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("1h ago");
    });

    it("handles timestamp at exactly 24 hours", () => {
      const timestamp = Date.now() - 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("Yesterday");
    });

    it("handles timestamp at exactly 48 hours", () => {
      const timestamp = Date.now() - 48 * 60 * 60 * 1000;
      expect(formatRelativeTime(timestamp)).toBe("2d ago");
    });
  });

  describe("edge cases", () => {
    it("handles future timestamps gracefully", () => {
      const future = Date.now() + 1000;
      expect(formatRelativeTime(future)).toBe("just now");
    });

    it("handles very old timestamps", () => {
      const old = new Date("2020-01-01").getTime();
      const result = formatRelativeTime(old);
      // Should return a date string (contains letters and numbers)
      expect(result).toMatch(/[A-Za-z]+.*\d+/);
    });

    it("handles timestamp of zero", () => {
      const result = formatRelativeTime(0);
      // Zero timestamp is very old (1970)
      // Should return a date string (contains letters and numbers)
      expect(result).toMatch(/[A-Za-z]+.*\d+|\d+.*\d+/);
    });
  });
});
