import { describe, expect, it } from "vitest";

import type { OverseerTelemetrySnapshot } from "./monitor.js";
import { reconcileOverseerState } from "./runner.js";
import type { OverseerStore } from "./store.types.js";

function buildStore(now: number): OverseerStore {
  return {
    version: 1,
    goals: {
      goal_1: {
        goalId: "goal_1",
        title: "Test goal",
        createdAt: now,
        updatedAt: now,
        status: "active",
        priority: "normal",
        tags: [],
        problemStatement: "Test",
        successCriteria: [],
        nonGoals: [],
        plan: {
          planVersion: 1,
          phases: [
            {
              id: "P1",
              name: "Phase",
              status: "todo",
              createdAt: now,
              updatedAt: now,
              tasks: [
                {
                  id: "T1.1",
                  name: "Task",
                  status: "todo",
                  createdAt: now,
                  updatedAt: now,
                  subtasks: [
                    {
                      id: "S1.1.1",
                      name: "Subtask",
                      status: "todo",
                      createdAt: now,
                      updatedAt: now,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    assignments: {
      A1: {
        assignmentId: "A1",
        goalId: "goal_1",
        workNodeId: "S1.1.1",
        sessionKey: "agent:main",
        status: "dispatched",
        dispatchHistory: [],
        createdAt: now,
        updatedAt: now,
        lastDispatchAt: now - 10_000,
      },
    },
    crystallizations: {},
    dispatchIndex: {},
    events: [],
    updatedAt: now,
  };
}

describe("reconcileOverseerState", () => {
  it("nudges stalled assignments after idle threshold", () => {
    const now = Date.now();
    const store = buildStore(now);
    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };
    const cfg = {
      enabled: true,
      tickEveryMs: 60_000,
      idleAfterMs: 1_000,
      maxRetries: 1,
      minResendIntervalMs: 0,
      backoffBaseMs: 1000,
      backoffMaxMs: 10_000,
      allowAgents: new Set<string>(),
      allowAnyAgent: true,
      allowCrossAgent: true,
      defaultAgentId: "main",
    } as any;

    const outcome = reconcileOverseerState({ store, telemetry, cfg, now });
    expect(outcome.actions.length).toBe(1);
    expect(outcome.actions[0].type).toBe("nudge");
    expect(store.assignments.A1.dispatchHistory.length).toBe(1);
  });

  it("respects min resend interval", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.lastDispatchAt = now;
    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };
    const cfg = {
      enabled: true,
      tickEveryMs: 60_000,
      idleAfterMs: 1_000,
      maxRetries: 1,
      minResendIntervalMs: 60_000,
      backoffBaseMs: 1000,
      backoffMaxMs: 10_000,
      allowAgents: new Set<string>(),
      allowAnyAgent: true,
      allowCrossAgent: true,
      defaultAgentId: "main",
    } as any;

    const outcome = reconcileOverseerState({ store, telemetry, cfg, now });
    expect(outcome.actions.length).toBe(0);
  });
});
