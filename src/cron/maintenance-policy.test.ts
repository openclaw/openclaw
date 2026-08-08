// Covers the cron maintenance phase and role decision logic.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getMaintenancePhase,
  isManualRunAllowed,
  resolveMaintenancePhase,
  resolveMaintenancePhaseForCron,
} from "./maintenance-policy.js";

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

// Use a fixed instant at 2026-01-15T03:30:00Z (03:30 UTC) so the timezone
// math is predictable across machines.
const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0);

describe("resolveMaintenancePhase", () => {
  it("returns normal when maintenance is not configured", () => {
    const result = resolveMaintenancePhase({ cfg: cfg(), nowMs: AT_UTC_03_30, agentId: "ops" });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
    expect(result.nextPhaseChangeMs).toBeUndefined();
  });

  it("returns normal when maintenance.enabled is false", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({ enabled: false, start: "02:00", end: "04:00" }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
  });

  it("returns normal when window is half-configured (permissive)", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({ enabled: true, start: "02:00" /* no end */ }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.reason).toMatch(/incomplete/);
  });

  it("returns normal when window has invalid HH:MM", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({ enabled: true, start: "bad", end: "04:00" }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.reason).toMatch(/invalid/);
  });

  it("returns maintenance and allows role-allowed agent inside window", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30, // 03:30 UTC, inside [02:00, 04:00)
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("maintenance.role-allowed");
    expect(result.nextPhaseChangeMs).toBeGreaterThan(AT_UTC_03_30);
  });

  it("returns maintenance and blocks role-blocked agent inside window", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "main", // not in roster
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("maintenance.role-blocked");
  });

  it("blocks all agents when maintenanceAgents is empty (D4 default)", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: [],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
  });

  it("blocks all agents when maintenanceAgents is omitted (D4 default)", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
  });

  it("returns normal before window start", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "04:00",
        end: "06:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30, // 03:30 UTC, before 04:00
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
    expect(result.nextPhaseChangeMs).toBeGreaterThan(AT_UTC_03_30);
  });

  it("returns normal at window end (end-exclusive)", () => {
    const atEnd = Date.UTC(2026, 0, 15, 4, 0, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: atEnd,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
  });

  it("normalises agent ids case-insensitively", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["OPS"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.allowed).toBe(true);
  });

  it("uses agent defaults userTimezone when window.timezone is omitted", () => {
    // 03:30 in Asia/Shanghai == 19:30 UTC the prior day. The window
    // 03:00-04:00 local-time in Asia/Shanghai should be active at this UTC
    // instant.
    const atUtc19_30 = Date.UTC(2026, 0, 14, 19, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: {
        agents: { defaults: { userTimezone: "Asia/Shanghai" } },
        cron: {
          maintenance: {
            enabled: true,
            window: { start: "03:00", end: "04:00" },
            maintenanceAgents: ["ops"],
          },
        },
      },
      nowMs: atUtc19_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
  });

  it("'local' magic timezone falls back to host timezone", () => {
    const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const hostFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: hostTz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = hostFormatter.formatToParts(new Date(AT_UTC_03_30));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hostMin = Number(map.hour) * 60 + Number(map.minute);
    // Use a 60-minute window centred on the current host-time minute, so the
    // test is robust to whatever timezone the host happens to be in.
    const startMin = hostMin - 30;
    const endMin = hostMin + 30;
    const start = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(
      startMin % 60,
    ).padStart(2, "0")}`;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(
      2,
      "0",
    )}`;
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start,
        end,
        timezone: "local",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
  });
});

describe("getMaintenancePhase", () => {
  it("returns normal when not configured", () => {
    expect(getMaintenancePhase(cfg(), AT_UTC_03_30)).toBe("normal");
  });

  it("returns maintenance when inside window", () => {
    expect(
      getMaintenancePhase(
        cfg({ enabled: true, start: "02:00", end: "04:00", timezone: "UTC" }),
        AT_UTC_03_30,
      ),
    ).toBe("maintenance");
  });
});

describe("isManualRunAllowed (D1)", () => {
  it("returns true in normal phase regardless of allowManualRun", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({ enabled: true, start: "04:00", end: "06:00" }),
        nowMs: AT_UTC_03_30,
        agentId: "ops",
      }),
    ).toBe(true);
  });

  it("returns false in maintenance phase for role-blocked agent when allowManualRun is false (default)", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
        }),
        nowMs: AT_UTC_03_30,
        agentId: "main",
      }),
    ).toBe(false);
  });

  it("returns true in maintenance phase for role-allowed agent", () => {
    expect(
      isManualRunAllowed({
        cfg: cfg({
          enabled: true,
          start: "02:00",
          end: "04:00",
          timezone: "UTC",
          maintenanceAgents: ["ops"],
        }),
        nowMs: AT_UTC_03_30,
        agentId: "ops",
      }),
    ).toBe(true);
  });

  it("returns true in maintenance phase for any agent when allowManualRun is true (opt-in)", () => {
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
        agentId: "main",
      }),
    ).toBe(true);
  });
});

describe("resolveMaintenancePhaseForCron", () => {
  it("returns normal when maintenance block is undefined", () => {
    const result = resolveMaintenancePhaseForCron({
      maintenance: undefined,
      userTimezone: "UTC",
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.allowed).toBe(true);
  });

  it("forwards userTimezone to the resolver", () => {
    const atUtc19_30 = Date.UTC(2026, 0, 14, 19, 30, 0); // 03:30 next day in Shanghai
    const result = resolveMaintenancePhaseForCron({
      maintenance: {
        enabled: true,
        window: { start: "03:00", end: "04:00" },
        maintenanceAgents: ["ops"],
      },
      userTimezone: "Asia/Shanghai",
      nowMs: atUtc19_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(true);
  });

  it("uses the agent's decision when no roster is provided", () => {
    const result = resolveMaintenancePhaseForCron({
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
      },
      userTimezone: "UTC",
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false); // empty roster blocks everyone
  });
});

describe("DST safety of nextPhaseChangeMs", () => {
  // Reference instants used in DST tests. Verified against IANA tzdata 2026a.
  //
  // America/Los_Angeles, 2026 spring forward (March 8, 2026, 02:00 PST -> 03:00 PDT):
  //   2026-03-08 02:00 LA: DOES NOT EXIST (the clock jumps 02:00 -> 03:00)
  //   2026-03-08 03:00 LA == 2026-03-08 10:00 UTC (the first 03:00, PDT, UTC-7)
  //   2026-03-08 04:00 LA == 2026-03-08 11:00 UTC (PDT, UTC-7)
  //
  // America/Los_Angeles, 2026 fall back (November 1, 2026, 02:00 PDT -> 01:00 PST):
  //   2026-11-01 01:00 LA == 2026-11-01 08:00 UTC (the first 01:00, PDT, UTC-7)
  //   2026-11-01 01:00 LA == 2026-11-01 09:00 UTC (the second 01:00, PST, UTC-8)
  //   2026-11-01 03:00 LA == 2026-11-01 11:00 UTC (the only 03:00, PST, UTC-8)
  //
  // For the maintenance window, "next time HH:MM arrives" uses the post-DST
  // wall clock: 02:00 LA on spring-forward day = 03:00 PDT = 10:00 UTC;
  // 01:00 LA on fall-back day = first 01:00 PDT = 08:00 UTC.

  const LA = "America/Los_Angeles";

  it("returns the post-DST wall clock for a spring-forward start", () => {
    // 2026-03-08 07:30 UTC == 2026-03-07 23:30 PST, before the window.
    // Old wall-minute math: 02:00 LA - 23:30 PST = 150 wall minutes ->
    // 07:30 UTC + 150 min = 10:00 UTC, coincidentally correct.
    // The real correctness check is that the result lands at 02:00+ LA
    // (i.e. 03:00 PDT == 10:00 UTC), NOT at 04:00 LA.
    const nowUtc = Date.UTC(2026, 2, 8, 7, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: LA,
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 2, 8, 10, 0, 0));
  });

  it("returns the correct end instant inside a spring-forward window", () => {
    // 2026-03-08 10:30 UTC == 2026-03-08 03:30 PDT, INSIDE [02:00, 04:00).
    // The window ends at 04:00 LA == 04:00 PDT == 11:00 UTC.
    const nowUtc = Date.UTC(2026, 2, 8, 10, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: LA,
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 2, 8, 11, 0, 0));
  });

  it("returns the first occurrence for a fall-back start", () => {
    // 2026-11-01 06:30 UTC == 2026-10-31 23:30 PDT, before the window.
    // Window starts at 01:00 LA; the first occurrence is 01:00 PDT == 08:00 UTC.
    const nowUtc = Date.UTC(2026, 10, 1, 6, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "01:00",
        end: "03:00",
        timezone: LA,
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 10, 1, 8, 0, 0));
  });

  it("returns the correct end instant across a fall-back boundary", () => {
    // 2026-11-01 09:30 UTC == 2026-11-01 01:30 PST (post-fall-back, second 01:00).
    // Window is in effect; ends at 03:00 LA == 03:00 PST == 11:00 UTC.
    const nowUtc = Date.UTC(2026, 10, 1, 9, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "01:00",
        end: "03:00",
        timezone: LA,
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.allowed).toBe(false);
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 10, 1, 11, 0, 0));
  });

  it("UTC timezone is unaffected by DST (sanity check)", () => {
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "main",
    });
    expect(result.phase).toBe("maintenance");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 0, 15, 4, 0, 0));
  });

  it("rolls to the next day when today's target is already past (DST-safe)", () => {
    // 2026-03-08 11:30 UTC == 2026-03-08 04:30 PDT, AFTER the window.
    // Next change should be tomorrow's 02:00 LA == 02:00 PDT == 09:00 UTC.
    const nowUtc = Date.UTC(2026, 2, 8, 11, 30, 0);
    const result = resolveMaintenancePhase({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: LA,
        maintenanceAgents: ["ops"],
      }),
      nowMs: nowUtc,
      agentId: "ops",
    });
    expect(result.phase).toBe("normal");
    expect(result.nextPhaseChangeMs).toBe(Date.UTC(2026, 2, 9, 9, 0, 0));
  });
});
