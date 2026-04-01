import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveScheduleIntervalMs,
  resolveNextWindowBoundaryMs,
} from "./heartbeat-active-hours.js";

function cfgWithUserTimezone(userTimezone = "UTC"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        userTimezone,
      },
    },
  };
}

describe("resolveScheduleIntervalMs", () => {
  it("returns null when no schedule configured", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      resolveScheduleIntervalMs(cfg, undefined, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(null);
    expect(
      resolveScheduleIntervalMs(cfg, {}, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(null);
  });

  it("returns null when schedule is empty array", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      resolveScheduleIntervalMs(
        cfg,
        { schedule: [], activeHours: { timezone: "UTC" } },
        Date.UTC(2025, 0, 1, 10, 0, 0),
      ),
    ).toBe(null);
  });

  it("returns correct interval for a daytime window match", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "08:00", end: "18:00", every: "15m" }],
      activeHours: { timezone: "UTC" },
    };
    // 10:00 UTC is inside 08:00-18:00
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(15 * 60_000);
  });

  it("returns correct interval for overnight window match at late hour", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "22:00", end: "06:00", every: "2h" }],
      activeHours: { timezone: "UTC" },
    };
    // 23:30 UTC is inside 22:00-06:00 (overnight)
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 30, 0)),
    ).toBe(2 * 60 * 60_000);
  });

  it("returns correct interval for overnight window match at early hour", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "22:00", end: "06:00", every: "2h" }],
      activeHours: { timezone: "UTC" },
    };
    // 03:00 UTC is inside 22:00-06:00 (overnight)
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 3, 0, 0)),
    ).toBe(2 * 60 * 60_000);
  });

  it("returns null when current time does not match any window", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [
        { start: "08:00", end: "12:00", every: "10m" },
        { start: "14:00", end: "18:00", every: "20m" },
      ],
      activeHours: { timezone: "UTC" },
    };
    // 13:00 UTC is between the two windows
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 13, 0, 0)),
    ).toBe(null);
  });

  it("first-match-wins when entries overlap", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [
        { start: "08:00", end: "18:00", every: "15m" },
        { start: "10:00", end: "14:00", every: "5m" },
      ],
      activeHours: { timezone: "UTC" },
    };
    // 11:00 matches both entries; first one (15m) should win
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 11, 0, 0)),
    ).toBe(15 * 60_000);
  });

  it("skips entries with invalid time formats", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [
        { start: "bad", end: "18:00", every: "10m" },
        { start: "08:00", end: "25:00", every: "10m" },
        { start: "08:00", end: "18:00", every: "30m" },
      ],
      activeHours: { timezone: "UTC" },
    };
    // 10:00 UTC -- first two entries are invalid, third should match
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(30 * 60_000);
  });

  it("skips entries with invalid duration", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [
        { start: "08:00", end: "18:00", every: "not-a-duration" },
        { start: "08:00", end: "18:00", every: "20m" },
      ],
      activeHours: { timezone: "UTC" },
    };
    // 10:00 matches first entry but duration is invalid; falls through to second
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(20 * 60_000);
  });

  it("respects IANA timezone (America/New_York)", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "09:00", end: "17:00", every: "10m" }],
      activeHours: { timezone: "America/New_York" },
    };
    // Jan 1 2025: EST = UTC-5
    // 15:00 UTC = 10:00 EST -> inside 09:00-17:00 ET
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 15, 0, 0)),
    ).toBe(10 * 60_000);
    // 13:00 UTC = 08:00 EST -> outside 09:00-17:00 ET
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 13, 0, 0)),
    ).toBe(null);
  });

  it("uses user timezone when no activeHours.timezone set", () => {
    const cfg = cfgWithUserTimezone("America/New_York");
    const heartbeat = {
      schedule: [{ start: "09:00", end: "17:00", every: "10m" }],
      // no activeHours.timezone -- should inherit from userTimezone
    };
    // Jan 1 2025: EST = UTC-5
    // 15:00 UTC = 10:00 EST -> inside 09:00-17:00 ET
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 15, 0, 0)),
    ).toBe(10 * 60_000);
    // 13:00 UTC = 08:00 EST -> outside 09:00-17:00 ET
    expect(
      resolveScheduleIntervalMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 13, 0, 0)),
    ).toBe(null);
  });
});

describe("resolveNextWindowBoundaryMs", () => {
  it("returns null when no schedule configured", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      resolveNextWindowBoundaryMs(cfg, undefined, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(null);
    expect(
      resolveNextWindowBoundaryMs(cfg, {}, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(null);
    expect(
      resolveNextWindowBoundaryMs(
        cfg,
        { schedule: [] },
        Date.UTC(2025, 0, 1, 10, 0, 0),
      ),
    ).toBe(null);
  });

  it("returns correct ms to nearest future boundary", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [
        { start: "08:00", end: "18:00", every: "15m" },
        { start: "18:00", end: "23:00", every: "30m" },
      ],
      activeHours: { timezone: "UTC" },
    };
    // At 10:00 UTC, boundaries are 08:00, 18:00, 18:00 (deduped), 23:00
    // Nearest future: 18:00 (8 hours = 480 minutes away)
    expect(
      resolveNextWindowBoundaryMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(480 * 60_000);
  });

  it("handles overnight boundary rollover (current time near midnight)", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "06:00", end: "22:00", every: "15m" }],
      activeHours: { timezone: "UTC" },
    };
    // At 23:00 UTC, boundaries are 06:00 and 22:00
    // 22:00 is behind us -> wraps to next day = 23h away = 1380 min
    // 06:00 is ahead tomorrow = 7h away = 420 min
    // Nearest: 06:00 at 420 min
    expect(
      resolveNextWindowBoundaryMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 0, 0)),
    ).toBe(420 * 60_000);
  });

  it("skips boundaries at current minute", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = {
      schedule: [{ start: "10:00", end: "18:00", every: "15m" }],
      activeHours: { timezone: "UTC" },
    };
    // At exactly 10:00 UTC, the start boundary (10:00) should be skipped
    // Next boundary is end at 18:00 (8 hours = 480 min)
    expect(
      resolveNextWindowBoundaryMs(cfg, heartbeat, Date.UTC(2025, 0, 1, 10, 0, 0)),
    ).toBe(480 * 60_000);
  });
});
