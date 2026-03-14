import { describe, expect, it } from "vitest";
import {
  buildAgentActivitySummary,
  buildFormalRuntimeMonitoringSummary,
} from "./runtime-monitoring.js";

describe("buildAgentActivitySummary", () => {
  it("rolls agents into active, quiet, and idle buckets", () => {
    const now = new Date("2026-03-14T12:00:00.000Z").getTime();
    const summary = buildAgentActivitySummary({
      defaultAgentId: "gateway",
      now: () => now,
      agents: [
        {
          agentId: "gateway",
          isDefault: true,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [{ key: "a", updatedAt: now - 2 * 60_000, age: 2 * 60_000 }] },
        },
        {
          agentId: "risk",
          isDefault: false,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [{ key: "b", updatedAt: now - 30 * 60_000, age: 30 * 60_000 }] },
        },
        {
          agentId: "news",
          isDefault: false,
          heartbeat: { enabled: false, everyMs: null },
          sessions: { recent: [] },
        },
      ],
    });

    expect(summary).toMatchObject({
      defaultAgentId: "gateway",
      total: 3,
      active: 1,
      quiet: 1,
      idle: 1,
      heartbeatEnabled: 2,
      heartbeatDisabled: 1,
    });
    expect(summary.entries.map((entry) => [entry.agentId, entry.status])).toEqual([
      ["gateway", "active"],
      ["risk", "quiet"],
      ["news", "idle"],
    ]);
  });
});

describe("buildFormalRuntimeMonitoringSummary", () => {
  it("raises structured issues for quantd unreachable and idle default agent", () => {
    const now = new Date("2026-03-14T12:00:00.000Z").getTime();
    const summary = buildFormalRuntimeMonitoringSummary({
      defaultAgentId: "gateway",
      now: () => now,
      agents: [
        {
          agentId: "gateway",
          isDefault: true,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [] },
        },
        {
          agentId: "risk",
          isDefault: false,
          heartbeat: { enabled: false, everyMs: null },
          sessions: { recent: [] },
        },
      ],
      quantd: {
        enabled: true,
        status: "unreachable",
        error: "connect ECONNREFUSED",
      },
    });

    expect(summary.status).toBe("degraded");
    expect(summary.issueCounts).toEqual({
      P0: 1,
      P1: 1,
      P2: 2,
      INFO: 0,
    });
    expect(summary.issues).toEqual([
      expect.objectContaining({
        code: "quantd.unreachable",
        priority: "P0",
      }),
      expect.objectContaining({
        code: "agents.default_idle",
        priority: "P1",
      }),
      expect.objectContaining({
        code: "agents.all_idle",
        priority: "P2",
      }),
      expect.objectContaining({
        code: "agents.heartbeat_disabled",
        priority: "P2",
      }),
    ]);
  });

  it("stays ok when quantd is disabled and the default agent is active", () => {
    const now = new Date("2026-03-14T12:00:00.000Z").getTime();
    const summary = buildFormalRuntimeMonitoringSummary({
      defaultAgentId: "gateway",
      now: () => now,
      agents: [
        {
          agentId: "gateway",
          isDefault: true,
          heartbeat: { enabled: true, everyMs: 60_000 },
          sessions: { recent: [{ updatedAt: now - 60_000 }] },
        },
      ],
      quantd: {
        enabled: false,
        status: "disabled",
      },
    });

    expect(summary.status).toBe("ok");
    expect(summary.issueCounts).toEqual({
      P0: 0,
      P1: 0,
      P2: 0,
      INFO: 0,
    });
    expect(summary.issues).toEqual([]);
  });
});
