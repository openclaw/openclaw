import { describe, expect, it } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";

describe("cron schedule", () => {
  it("computes next run for cron expression with timezone", () => {
    // Saturday, Dec 13 2025 00:00:00Z
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 9 * * 3", tz: "America/Los_Angeles" },
      nowMs,
    );
    // Next Wednesday at 09:00 PST -> 17:00Z
    expect(next).toBe(Date.parse("2025-12-17T17:00:00.000Z"));
  });

  it("computes next run for every schedule", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const now = anchor + 10_000;
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000, anchorMs: anchor }, now);
    expect(next).toBe(anchor + 30_000);
  });

  it("computes next run for every schedule when anchorMs is not provided", () => {
    const now = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000 }, now);

    // Should return nowMs + everyMs, not nowMs (which would cause infinite loop)
    expect(next).toBe(now + 30_000);
  });

  it("advances when now matches anchor for every schedule", () => {
    const anchor = Date.parse("2025-12-13T00:00:00.000Z");
    const next = computeNextRunAtMs({ kind: "every", everyMs: 30_000, anchorMs: anchor }, anchor);
    expect(next).toBe(anchor + 30_000);
  });

  describe("cron with specific seconds (6-field pattern)", () => {
    // Pattern: fire at exactly second 0 of minute 0 of hour 12 every day
    const dailyNoon = { kind: "cron" as const, expr: "0 0 12 * * *", tz: "UTC" };
    const noonMs = Date.parse("2026-02-08T12:00:00.000Z");

    it("returns current occurrence when nowMs is exactly at the match", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs);
      expect(next).toBe(noonMs);
    });

    it("returns current occurrence when nowMs is mid-second (.500) within the match", () => {
      // This is the core regression: without the second-floor fix, a 1ms
      // lookback from 12:00:00.499 still lands inside the matching second,
      // causing croner to skip to the *next day*.
      const next = computeNextRunAtMs(dailyNoon, noonMs + 500);
      expect(next).toBe(noonMs);
    });

    it("returns current occurrence when nowMs is late in the matching second (.999)", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 999);
      expect(next).toBe(noonMs);
    });

    it("advances to next day once the matching second is fully past", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs + 1000);
      expect(next).toBe(noonMs + 86_400_000); // next day
    });

    it("returns today when nowMs is before the match", () => {
      const next = computeNextRunAtMs(dailyNoon, noonMs - 500);
      expect(next).toBe(noonMs);
    });
  });
});
