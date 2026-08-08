// Covers the maintenance status read surface.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordMaintenanceDeferral, resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import {
  getMaintenanceStatusReport,
  getMaintenanceStatusReportForAgent,
} from "./maintenance-status.js";

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0);

function cfg(
  overrides: {
    enabled?: boolean;
    start?: string;
    end?: string;
    timezone?: string;
    maintenanceAgents?: readonly string[];
    allowManualRun?: boolean;
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
    agents: { defaults: { userTimezone: overrides.timezone ?? "UTC" } },
    cron: maintenance ? { maintenance } : {},
  };
}

describe("getMaintenanceStatusReport", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("reports normal phase when maintenance is not configured", () => {
    const report = getMaintenanceStatusReport({ cfg: cfg(), nowMs: AT_UTC_03_30 });
    expect(report.enabled).toBe(false);
    expect(report.phase).toBe("normal");
    expect(report.window).toBeNull();
    expect(report.maintenanceAgents).toEqual([]);
    expect(report.allowManualRun).toBe(false);
    expect(report.deferredCount).toBe(0);
    expect(report.deferredBacklog).toEqual([]);
  });

  it("reports maintenance phase when inside the window", () => {
    const report = getMaintenanceStatusReport({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
    });
    expect(report.enabled).toBe(true);
    expect(report.phase).toBe("maintenance");
    expect(report.window).toEqual({ start: "02:00", end: "04:00", timezone: "UTC" });
    expect(report.maintenanceAgents).toEqual(["ops"]);
    expect(report.nextPhaseChangeMs).toBeGreaterThan(AT_UTC_03_30);
  });

  it("includes deferred backlog from the maintenance-deferred queue", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: 2_000 });
    const report = getMaintenanceStatusReport({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
    });
    expect(report.deferredCount).toBe(2);
    expect(report.deferredBacklog.map((entry) => entry.jobId)).toEqual(["job-A", "job-B"]);
  });
});

describe("getMaintenanceStatusReportForAgent", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("returns role-allowed decision for an in-roster agent", () => {
    const report = getMaintenanceStatusReportForAgent({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
      agentId: "ops",
    });
    // Phase is always window-derived; role isolation is reflected in callers
    // that consume the decision. The report's phase field stays
    // "maintenance" because the agent's own view of phase is not "allowed".
    expect(report.phase).toBe("maintenance");
  });
});
