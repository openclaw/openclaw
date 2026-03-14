import { describe, expect, it } from "vitest";
import { diffFormalRuntimeMonitoringIssues } from "./runtime-monitoring-alerts.js";
import type { FormalRuntimeMonitoringSummary } from "./runtime-monitoring.js";

function createSummary(
  overrides: Partial<FormalRuntimeMonitoringSummary> = {},
): FormalRuntimeMonitoringSummary {
  return {
    status: "ok",
    agents: {
      defaultAgentId: "gateway",
      total: 1,
      active: 1,
      quiet: 0,
      idle: 0,
      heartbeatEnabled: 1,
      heartbeatDisabled: 0,
      entries: [],
    },
    quantd: {
      status: "ok",
    },
    issues: [],
    issueCounts: {
      P0: 0,
      P1: 0,
      P2: 0,
      INFO: 0,
    },
    ...overrides,
  };
}

describe("diffFormalRuntimeMonitoringIssues", () => {
  it("returns opened events for newly raised issues", () => {
    const next = createSummary({
      status: "degraded",
      issues: [
        {
          code: "quantd.unreachable",
          priority: "P0",
          summary: "quantd currently unreachable",
        },
      ],
      issueCounts: { P0: 1, P1: 0, P2: 0, INFO: 0 },
    });

    expect(diffFormalRuntimeMonitoringIssues(undefined, next)).toEqual([
      expect.objectContaining({
        transition: "opened",
        issue: expect.objectContaining({
          code: "quantd.unreachable",
          priority: "P0",
        }),
      }),
    ]);
  });

  it("returns resolved events when an issue clears", () => {
    const previous = createSummary({
      status: "degraded",
      issues: [
        {
          code: "agents.default_idle",
          priority: "P1",
          summary: "default agent gateway is idle",
        },
      ],
      issueCounts: { P0: 0, P1: 1, P2: 0, INFO: 0 },
    });
    const next = createSummary();

    expect(diffFormalRuntimeMonitoringIssues(previous, next)).toEqual([
      expect.objectContaining({
        transition: "resolved",
        issue: expect.objectContaining({
          code: "agents.default_idle",
          priority: "P1",
        }),
      }),
    ]);
  });

  it("does not re-emit unchanged issues", () => {
    const previous = createSummary({
      status: "degraded",
      issues: [
        {
          code: "agents.heartbeat_disabled",
          priority: "P2",
          summary: "1 formal agents have heartbeat disabled",
        },
      ],
      issueCounts: { P0: 0, P1: 0, P2: 1, INFO: 0 },
    });
    const next = createSummary({
      status: "degraded",
      issues: [
        {
          code: "agents.heartbeat_disabled",
          priority: "P2",
          summary: "1 formal agents have heartbeat disabled",
        },
      ],
      issueCounts: { P0: 0, P1: 0, P2: 1, INFO: 0 },
    });

    expect(diffFormalRuntimeMonitoringIssues(previous, next)).toEqual([]);
  });
});
