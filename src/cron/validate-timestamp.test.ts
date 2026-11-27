// Timestamp validation tests cover cron timestamp parsing and stale value rejection.
import { describe, expect, it, vi } from "vitest";
import { validateScheduleTimestamp } from "./validate-timestamp.js";

describe("validateScheduleTimestamp", () => {
  it("falls back instead of throwing for invalid validation clocks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00.000Z"));
    try {
      const result = validateScheduleTimestamp(
        { kind: "at", at: "2026-02-23T11:00:00.000Z" },
        Number.POSITIVE_INFINITY,
      );

      expect(result).toEqual({
        ok: false,
        message:
          "That time is in the past (2026-02-23T11:00:00.000Z). Choose a time after 2026-02-23T12:00:00.000Z.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects at timestamps more than ten years ahead", () => {
    const result = validateScheduleTimestamp(
      { kind: "at", at: "2037-01-01T00:00:00.000Z" },
      Date.parse("2026-02-23T12:00:00.000Z"),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "The scheduled time (2037-01-01T00:00:00.000Z) is more than 10 years away. Choose an earlier date and time.",
    });
  });
});
