import { describe, expect, it } from "vitest";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs,
} from "./heartbeat-schedule.js";

describe("heartbeat schedule helpers", () => {
  it("derives a stable per-agent phase inside the interval", () => {
    const first = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });
    const second = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(60 * 60_000);
  });

  it("returns the next future slot for the agent phase", () => {
    const intervalMs = 60 * 60_000;
    const phaseMs = 15 * 60_000;

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:10:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T10:15:00.000Z"));

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:15:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T11:15:00.000Z"));
  });

  it("preserves an unchanged future schedule across config reloads", () => {
    const nextDueMs = Date.parse("2026-01-01T11:15:00.000Z");

    expect(
      resolveNextHeartbeatDueMs({
        nowMs: Date.parse("2026-01-01T10:20:00.000Z"),
        intervalMs: 60 * 60_000,
        phaseMs: 15 * 60_000,
        prev: {
          intervalMs: 60 * 60_000,
          phaseMs: 15 * 60_000,
          nextDueMs,
        },
      }),
    ).toBe(nextDueMs);
  });
});

describe("seekNextActivePhaseDueMs", () => {
  const HOUR = 60 * 60_000;

  it("returns startMs immediately when no isActive predicate is provided", () => {
    const startMs = Date.parse("2026-01-01T03:00:00.000Z");
    expect(
      seekNextActivePhaseDueMs({
        startMs,
        intervalMs: 4 * HOUR,
        phaseMs: 0,
      }),
    ).toBe(startMs);
  });

  it("returns startMs when the first slot is already within active hours", () => {
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    expect(
      seekNextActivePhaseDueMs({
        startMs,
        intervalMs: 4 * HOUR,
        phaseMs: 0,
        isActive: () => true,
      }),
    ).toBe(startMs);
  });

  it("skips quiet-hours slots and returns the first in-window slot", () => {
    // Active window: 08:00 – 17:00 UTC
    // Interval: 4h, start slot at 19:00 UTC (quiet hours)
    // Next slots: 23:00 (quiet), 03:00 (quiet), 07:00 (quiet), 11:00 (active!)
    const startMs = Date.parse("2026-01-01T19:00:00.000Z");
    const intervalMs = 4 * HOUR;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 8 && hour < 17;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    // 19:00 + 4h = 23:00 (skip) + 4h = 03:00 (skip) + 4h = 07:00 (skip) + 4h = 11:00
    expect(result).toBe(Date.parse("2026-01-02T11:00:00.000Z"));
  });

  it("handles overnight active windows correctly", () => {
    // Active window: 22:00 – 06:00 UTC (overnight)
    // Interval: 4h, start slot at 10:00 UTC (quiet hours)
    // Next: 14:00 (quiet), 18:00 (quiet), 22:00 (active!)
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    const intervalMs = 4 * HOUR;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 22 || hour < 6;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-01T22:00:00.000Z"));
  });

  it("falls back to startMs when no slot is active within the seek horizon", () => {
    // All slots are outside active hours (isActive always returns false)
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: 4 * HOUR,
      phaseMs: 0,
      isActive: () => false,
    });

    expect(result).toBe(startMs);
  });

  it("seeks across timezone-aware active hours using isWithinActiveHours semantics", () => {
    // Simulate Asia/Shanghai: active 08:00-23:00 local = 00:00-15:00 UTC
    // Interval: 4h, phase slot at 15:21 UTC (23:21 Shanghai = quiet)
    // Next: 19:21 UTC (03:21 Shanghai = quiet), 23:21 UTC (07:21 = quiet),
    //       03:21 UTC (11:21 Shanghai = active!)
    const startMs = Date.parse("2026-01-01T15:21:00.000Z");
    const intervalMs = 4 * HOUR;
    const shanghaiOffsetMs = 8 * HOUR;

    const isActive = (ms: number) => {
      // Simulate Asia/Shanghai = UTC+8, active 08:00-23:00
      const shanghaiMs = ms + shanghaiOffsetMs;
      const shanghaiHour = new Date(shanghaiMs).getUTCHours();
      return shanghaiHour >= 8 && shanghaiHour < 23;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    // 15:21 + 4h = 19:21 (skip) + 4h = 23:21 (skip) + 4h = 03:21 UTC = 11:21 Shanghai
    expect(result).toBe(Date.parse("2026-01-02T03:21:00.000Z"));
  });

  it("handles very short intervals efficiently", () => {
    // 30-minute interval, active window 09:00-17:00
    // Start at 17:00 (quiet), should find 09:00 next day
    const startMs = Date.parse("2026-01-01T17:00:00.000Z");
    const intervalMs = 30 * 60_000;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 9 && hour < 17;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    // Should skip 32 half-hour slots (17:00 through 08:30) to reach 09:00 next day
    expect(result).toBe(Date.parse("2026-01-02T09:00:00.000Z"));
  });
});
