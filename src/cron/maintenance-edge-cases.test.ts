// TDD edge-case coverage for the maintenance window feature.
// Each \`it\` describes a real operator scenario; tests are written to fail
// first (red) and document the expected behaviour, then are made green by
// the production code.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import {
  isManualRunAllowed,
  resolveMaintenancePhase,
  resolveMaintenancePhaseForCron,
} from "./maintenance-policy.js";

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0);
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0);

function cfg(
  overrides: {
    enabled?: boolean;
    start?: string;
    end?: string;
    timezone?: string;
    maintenanceAgents?: readonly string[];
    allowManualRun?: boolean;
    userTimezone?: string;
  } = {},
): OpenClawConfig {
  const maintenance = overrides.enabled
    ? {
        enabled: true,
        window: {
          start: overrides.start,
          end: overrides.end,
          timezone: overrides.timezone,
        },
        maintenanceAgents: overrides.maintenanceAgents,
        allowManualRun: overrides.allowManualRun,
      }
    : undefined;
  return {
    agents: { defaults: { userTimezone: overrides.userTimezone ?? "UTC" } },
    cron: maintenance ? { maintenance } : {},
  };
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("DST edge cases (resolver correctness)", () => {
  it("handles the 2024 leap year spring forward (US)", () => {
    // 2024-03-10 02:00 PST -> 03:00 PDT.
    // Pre-window at 2024-03-10 07:30 UTC == 2024-03-09 23:30 PST.
    // Next change is the post-DST 02:00 LA (03:00 PDT) == 10:00 UTC.
    const nowUtc = Date.UTC(2024, 2, 10, 7, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "America/Los_Angeles",
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2024, 2, 10, 10, 0, 0));
  });

  it("handles southern hemisphere DST (Sydney, October spring forward)", () => {
    // Sydney DST: 2026-10-04 02:00 AEST -> 03:00 AEDT (spring forward in
    // the southern hemisphere). Pre-window at 2026-10-03 15:30 UTC ==
    // 2026-10-04 02:30 AEST, which is the non-existent 02:00-03:00 hour.
    // The expected post-DST 02:00 Sydney = 03:00 AEDT = 2026-10-03 16:00 UTC.
    const nowUtc = Date.UTC(2026, 9, 3, 15, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "Australia/Sydney",
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 9, 3, 16, 0, 0));
  });

  it("handles 30-minute-offset timezone (India, no DST)", () => {
    // Asia/Kolkata is UTC+5:30, no DST. Window 02:00-04:00 IST.
    // 2026-06-15 21:00 UTC == 2026-06-16 02:30 IST, inside the window.
    const nowUtc = Date.UTC(2026, 5, 15, 21, 0, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "Asia/Kolkata",
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    // Window end: 04:00 IST = 22:30 UTC same day.
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 5, 15, 22, 30, 0));
  });

  it("handles 45-minute-offset timezone (Nepal, no DST)", () => {
    // Asia/Kathmandu is UTC+5:45, no DST. Window 02:00-04:00 NPT.
    // 2026-06-15 20:30 UTC == 2026-06-16 02:15 NPT, inside the window.
    const nowUtc = Date.UTC(2026, 5, 15, 20, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "Asia/Kathmandu",
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    // Window end: 04:00 NPT = 22:15 UTC same day.
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 5, 15, 22, 15, 0));
  });
});

describe("24:00 window end", () => {
  it("accepts '24:00' as the end time and treats it as end-of-day", () => {
    // Window 23:00-24:00 LA. Pre-window at 22:30 LA. The window starts at
    // 23:00 LA the same day (06:00 UTC) and ends at 24:00 LA = next day
    // 00:00 PDT = 07:00 UTC (or PST depending on DST; for 2026-01-15
    // we're in PST so 24:00 PST = 08:00 UTC).
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "23:00",
        end: "24:00",
        timezone: "America/Los_Angeles",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_05_00, // 2026-01-15 05:00 UTC == 2026-01-14 21:00 PST, before window
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    // Next change: 23:00 PST on 2026-01-15 == 07:00 UTC.
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 0, 15, 7, 0, 0));
  });

  it("does not allow 24:00 as a start time", () => {
    // The schema rejects start >= end, but the parser also rejects
    // '24:00' as a start independently (only as an end).
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "24:00", // invalid as a start
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.reason).toMatch(/invalid/);
  });
});

describe("manual run gate semantics", () => {
  it("blocks a manual run by a non-roster agent in maintenance phase", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
          allowManualRun: false,
        }),
        nowMs: AT_UTC_03_30,
        agentId: "main",
      }),
    ).toBe(false);
  });

  it("allows a manual run by an in-roster agent in maintenance phase", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
          allowManualRun: false,
        }),
        nowMs: AT_UTC_03_30,
        agentId: "ops",
      }),
    ).toBe(true);
  });

  it("allows a manual run by any agent when allowManualRun is true (D1 opt-in)", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
          allowManualRun: true,
        }),
        nowMs: AT_UTC_03_30,
        agentId: "anyone",
      }),
    ).toBe(true);
  });

  it("allows manual runs outside the window regardless of allowManualRun", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
          allowManualRun: false,
        }),
        nowMs: AT_UTC_05_00,
        agentId: "main",
      }),
    ).toBe(true);
  });
});

describe("resolveMaintenancePhaseForCron cron-service flavour", () => {
  it("returns normal when the maintenance block is undefined", () => {
    const result = resolveMaintenancePhaseForCron({
      maintenance: undefined,
      userTimezone: "UTC",
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
    expect(result.nextPhaseChangeMs).toBeUndefined();
  });

  it("uses userTimezone when window.timezone is omitted or 'user'", () => {
    // userTimezone: Asia/Shanghai, window 03:00-04:00, no window.timezone.
    // 19:30 UTC the prior day == 03:30 Shanghai the next day, inside the window.
    const nowUtc = Date.UTC(2026, 0, 14, 19, 30, 0);
    const result = resolveMaintenancePhaseForCron({
      maintenance: {
        enabled: true,
        window: { start: "03:00", end: "04:00" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "Asia/Shanghai",
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(true);
  });
});
