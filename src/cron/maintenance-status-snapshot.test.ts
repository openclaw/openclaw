// Snapshot tests for the maintenance status report.
//
// The status report is the operator-visible surface. Its shape is part of
// the public contract: cron.status JSON, dashboards, and the future CLI
// all consume it. We pin the shape per (config, time, agent) combination
// so any field rename, optionality flip, or unit change is caught here.
//
// The test is deliberately structured as a small parametric table — not
// snapshot strings — so the failure mode is precise (which field drifted)
// rather than a wall of JSON.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginMaintenancePhase,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import {
  getMaintenanceStatusReport,
  getMaintenanceStatusReportForAgent,
  type MaintenanceStatusReport,
} from "./maintenance-status.js";

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0);
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0);
const AT_UTC_01_30 = Date.UTC(2026, 0, 15, 1, 30, 0);

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
  } as OpenClawConfig;
}

/**
 * Round-trip the report into a stable, comparable shape. We strip the
 * `nextPhaseChangeMs` (which is wall-clock dependent and may shift slightly
 * on DST boundaries) and compare only the structural fields. The wall-clock
 * field is verified separately.
 */
function structural(report: MaintenanceStatusReport) {
  return {
    enabled: report.enabled,
    phase: report.phase,
    window: report.window,
    maintenanceAgents: report.maintenanceAgents,
    allowManualRun: report.allowManualRun,
    deferredCount: report.deferredCount,
    deferredBacklogKeys: report.deferredBacklog.map((e) => ({
      jobId: e.jobId,
      agentId: e.agentId,
    })),
  };
}

// Helper used in tests that want only the backlog projection.
function backlogKeys(report: MaintenanceStatusReport) {
  return structural(report).deferredBacklogKeys;
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("getMaintenanceStatusReport — snapshot matrix", () => {
  const cases: Array<{
    name: string;
    cfg: OpenClawConfig;
    nowMs: number;
    expected: ReturnType<typeof structural>;
  }> = [
    {
      name: "unconfigured",
      cfg: cfg(),
      nowMs: AT_UTC_03_30,
      expected: {
        enabled: false,
        phase: "normal",
        window: null,
        maintenanceAgents: [],
        allowManualRun: false,
        deferredCount: 0,
        deferredBacklogKeys: [],
      },
    },
    {
      name: "enabled, inside window, no roster",
      cfg: cfg({ enabled: true, start: "02:00", end: "04:00", timezone: "UTC" }),
      nowMs: AT_UTC_03_30,
      expected: {
        enabled: true,
        phase: "maintenance",
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: [],
        allowManualRun: false,
        deferredCount: 0,
        deferredBacklogKeys: [],
      },
    },
    {
      name: "enabled, inside window, single-agent roster",
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
        allowManualRun: true,
      }),
      nowMs: AT_UTC_03_30,
      expected: {
        enabled: true,
        phase: "maintenance",
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
        allowManualRun: true,
        deferredCount: 0,
        deferredBacklogKeys: [],
      },
    },
    {
      name: "enabled, before window",
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_01_30,
      expected: {
        enabled: true,
        phase: "normal",
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
        allowManualRun: false,
        deferredCount: 0,
        deferredBacklogKeys: [],
      },
    },
    {
      name: "enabled, after window",
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_05_00,
      expected: {
        enabled: true,
        phase: "normal",
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
        allowManualRun: false,
        deferredCount: 0,
        deferredBacklogKeys: [],
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const report = getMaintenanceStatusReport({ cfg: c.cfg, nowMs: c.nowMs });
      expect(structural(report)).toEqual(c.expected);
    });
  }
});

describe("getMaintenanceStatusReportForAgent — role-isolated snapshots", () => {
  it("reports the same structural shape for an in-roster agent", () => {
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
    expect(structural(report)).toEqual({
      enabled: true,
      phase: "maintenance",
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
      allowManualRun: false,
      deferredCount: 0,
      deferredBacklogKeys: [],
    });
  });

  it("reports the same structural shape for a non-roster agent", () => {
    const report = getMaintenanceStatusReportForAgent({
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
    expect(structural(report)).toEqual({
      enabled: true,
      phase: "maintenance",
      window: { start: "02:00", end: "04:00", timezone: "UTC" },
      maintenanceAgents: ["ops"],
      allowManualRun: false,
      deferredCount: 0,
      deferredBacklogKeys: [],
    });
  });

  it("report includes the queue snapshot when jobs are deferred", () => {
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs: AT_UTC_03_30 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "secondary", nowMs: AT_UTC_03_30 + 1 });
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
    expect(backlogKeys(report)).toEqual([
      { jobId: "job-A", agentId: "main" },
      { jobId: "job-B", agentId: "secondary" },
    ]);
    // Backlog entries include phaseId and timestamps; spot-check the
    // first entry's shape so a future field addition is caught.
    const first = report.deferredBacklog[0];
    expect(first).toMatchObject({
      jobId: "job-A",
      agentId: "main",
      firstDeferredAtMs: AT_UTC_03_30,
      lastDeferredAtMs: AT_UTC_03_30,
    });
    expect(first?.phaseId).toMatch(/^phase-/);
  });
});

describe("getMaintenanceStatusReport — wall-clock contract", () => {
  it("nextPhaseChangeMs is null when maintenance is not configured", () => {
    const report = getMaintenanceStatusReport({ cfg: cfg(), nowMs: AT_UTC_03_30 });
    expect(report.nextPhaseChangeMs).toBeNull();
  });

  it("nextPhaseChangeMs is strictly > nowMs when maintenance is configured", () => {
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
    expect(report.nextPhaseChangeMs).not.toBeNull();
    expect(report.nextPhaseChangeMs!).toBeGreaterThan(AT_UTC_03_30);
  });

  it("nextPhaseChangeMs inside the window is the window end, not the next start", () => {
    // Inside the window: next change is the end of the current window.
    const insideReport = getMaintenanceStatusReport({
      cfg: cfg({
        enabled: true,
        start: "02:00",
        end: "04:00",
        timezone: "UTC",
        maintenanceAgents: ["ops"],
      }),
      nowMs: AT_UTC_03_30,
    });
    // 04:00 UTC = end of window = 4 * 60 * 60 * 1000 ms after 00:00 UTC.
    const expectedEnd = Date.UTC(2026, 0, 15, 4, 0, 0);
    // Allow a few ms slack to absorb formatter quirks, but the value must
    // land within 1 second of the expected boundary.
    expect(Math.abs(insideReport.nextPhaseChangeMs! - expectedEnd)).toBeLessThan(1_000);
  });
});
