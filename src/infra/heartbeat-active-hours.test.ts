// Covers heartbeat active-hours evaluation.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createActiveHoursPredicate, isWithinActiveHours } from "./heartbeat-active-hours.js";

function cfgWithUserTimezone(userTimezone = "UTC"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        userTimezone,
      },
    },
  };
}

function heartbeatWindow(start: string, end: string, timezone: string) {
  return {
    activeHours: {
      start,
      end,
      timezone,
    },
  };
}

describe("isWithinActiveHours", () => {
  it("returns true when activeHours is not configured", () => {
    expect(
      isWithinActiveHours(cfgWithUserTimezone("UTC"), undefined, Date.UTC(2025, 0, 1, 3)),
    ).toBe(true);
  });

  it("returns true when activeHours start/end are invalid", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      isWithinActiveHours(cfg, heartbeatWindow("bad", "10:00", "UTC"), Date.UTC(2025, 0, 1, 9)),
    ).toBe(true);
    expect(
      isWithinActiveHours(cfg, heartbeatWindow("08:00", "24:30", "UTC"), Date.UTC(2025, 0, 1, 9)),
    ).toBe(true);
  });

  it("returns false when activeHours start equals end", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      isWithinActiveHours(
        cfg,
        heartbeatWindow("08:00", "08:00", "UTC"),
        Date.UTC(2025, 0, 1, 12, 0, 0),
      ),
    ).toBe(false);
  });

  it("respects user timezone windows for normal ranges", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("08:00", "24:00", "user");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 7, 0, 0))).toBe(false);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 8, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 59, 0))).toBe(true);
  });

  it("supports overnight ranges", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("22:00", "06:00", "UTC");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 5, 30, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 12, 0, 0))).toBe(false);
  });

  it("respects explicit non-user timezones", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("09:00", "17:00", "America/New_York");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 15, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 30, 0))).toBe(false);
  });

  it("evaluates repeated schedule probes with a prepared predicate", () => {
    const isActive = createActiveHoursPredicate(
      cfgWithUserTimezone("UTC"),
      heartbeatWindow("09:00", "17:00", "America/New_York"),
    );

    expect(isActive(Date.UTC(2025, 0, 1, 15, 0, 0))).toBe(true);
    expect(isActive(Date.UTC(2025, 0, 1, 23, 30, 0))).toBe(false);
  });

  it("falls back to user timezone when activeHours timezone is invalid", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("08:00", "10:00", "Mars/Olympus");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 9, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 11, 0, 0))).toBe(false);
  });

  it("returns permissive predicate when time parsing fails (fail-open)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cfg = cfgWithUserTimezone("UTC");
    // malformed time string that passes the Intl formatting but produces NaN
    const heartbeat = heartbeatWindow("invalid", "17:00", "UTC");

    const isActive = createActiveHoursPredicate(cfg, heartbeat);
    // Should return a permissive predicate that always allows heartbeats
    expect(isActive(Date.UTC(2025, 0, 1, 3, 0, 0))).toBe(true);
    warnSpy.mockRestore();
  });

  it("warns when Intl formatting fails inside resolveMinutesInTimeZone", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
      throw new Error("timezone database unavailable");
    });
    try {
      const cfg = cfgWithUserTimezone("UTC");
      const heartbeat = heartbeatWindow("09:00", "17:00", "UTC");
      const isActive = createActiveHoursPredicate(cfg, heartbeat);
      // Should still be permissive despite the formatter error
      expect(isActive(Date.now())).toBe(true);
    } finally {
      vi.restoreAllMocks();
      // Restore the original formatToParts
      Intl.DateTimeFormat.prototype.formatToParts = originalFormatToParts;
    }
  });
});
