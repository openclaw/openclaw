import { describe, expect, it } from "vitest";

import type { OverseerTelemetrySnapshot } from "./monitor.js";
import { reconcileOverseerState } from "./runner.js";
import type { OverseerStore } from "./store.types.js";

function buildStore(now: number, overrides?: Partial<OverseerStore>): OverseerStore {
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
    ...overrides,
  };
}

function buildCfg(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  } as any;
}

describe("reconcileOverseerState status transitions", () => {
  it("tracks transition from dispatched to stalled", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "dispatched";
    store.assignments.A1.lastDispatchAt = now - 60_000; // Old enough to be stalled

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 1_000 }),
      now,
    });

    expect(outcome.statusTransitions.length).toBe(1);
    expect(outcome.statusTransitions[0]).toMatchObject({
      assignmentId: "A1",
      from: "dispatched",
      to: "stalled",
    });
  });

  it("tracks transition from stalled to active when activity detected", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "stalled";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: {
          assignmentId: "A1",
          sessionKey: "agent:main",
          runActive: true, // Active run detected
        },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 60_000 }),
      now,
    });

    expect(outcome.statusTransitions.length).toBe(1);
    expect(outcome.statusTransitions[0]).toMatchObject({
      assignmentId: "A1",
      from: "stalled",
      to: "active",
    });
  });

  it("tracks transition from queued to dispatched", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "queued";
    store.assignments.A1.lastDispatchAt = undefined;

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg(),
      now,
    });

    expect(outcome.statusTransitions.length).toBe(1);
    expect(outcome.statusTransitions[0]).toMatchObject({
      assignmentId: "A1",
      from: "queued",
      to: "dispatched",
    });
  });

  it("does not track transitions when status unchanged", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "active";
    store.assignments.A1.lastObservedActivityAt = now; // Recent activity

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 60_000 }),
      now,
    });

    expect(outcome.statusTransitions.length).toBe(0);
  });

  it("includes assignment reference in transitions", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "dispatched";
    store.assignments.A1.lastDispatchAt = now - 60_000;

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 1_000 }),
      now,
    });

    expect(outcome.statusTransitions[0].assignment).toBeDefined();
    expect(outcome.statusTransitions[0].assignment.assignmentId).toBe("A1");
    expect(outcome.statusTransitions[0].assignment.status).toBe("stalled");
  });
});

describe("reconcileOverseerState policy enforcement", () => {
  it("skips assignments not matching allowAgents", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.agentId = "other-agent";
    store.assignments.A1.status = "queued";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {},
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({
        allowAnyAgent: false,
        allowCrossAgent: false,
        allowAgents: new Set(["main"]),
        defaultAgentId: "main",
      }),
      now,
    });

    // Should not dispatch for disallowed agent
    expect(outcome.actions.length).toBe(0);
    expect(outcome.statusTransitions.length).toBe(0);
  });

  it("allows assignments matching allowAgents", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.agentId = "allowed-agent";
    store.assignments.A1.status = "queued";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:allowed-agent" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({
        allowAnyAgent: false,
        allowCrossAgent: true,
        allowAgents: new Set(["allowed-agent"]),
      }),
      now,
    });

    expect(outcome.actions.length).toBe(1);
  });

  it("allows all agents when allowAnyAgent is true", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.agentId = "random-agent";
    store.assignments.A1.status = "queued";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:random-agent" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ allowAnyAgent: true, allowCrossAgent: true }),
      now,
    });

    expect(outcome.actions.length).toBe(1);
  });
});

describe("reconcileOverseerState structured updates", () => {
  it("applies structured update from telemetry", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "active";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: {
          assignmentId: "A1",
          sessionKey: "agent:main",
          structuredUpdate: {
            workNodeId: "S1.1.1",
            status: "done",
            summary: "Task completed",
          },
        },
      },
    };

    reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 60_000 }),
      now,
    });

    // Assignment should be marked done
    expect(store.assignments.A1.status).toBe("done");
    // Work node should be marked done
    const workNode = store.goals.goal_1.plan?.phases[0].tasks[0].subtasks[0];
    expect(workNode?.status).toBe("done");
    // Should have created crystallization
    expect(Object.keys(store.crystallizations).length).toBe(1);
  });

  it("handles blocked status with blockers", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "active";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: {
          assignmentId: "A1",
          sessionKey: "agent:main",
          structuredUpdate: {
            status: "blocked",
            blockers: ["Waiting for API access", "Need credentials"],
          },
        },
      },
    };

    reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 60_000 }),
      now,
    });

    expect(store.assignments.A1.status).toBe("blocked");
    expect(store.assignments.A1.blockedReason).toContain("Waiting for API access");
    expect(store.assignments.A1.blockedReason).toContain("Need credentials");
  });
});

describe("reconcileOverseerState recovery policies", () => {
  it("respects backoff until time", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "stalled";
    store.assignments.A1.backoffUntil = now + 60_000; // Future
    store.assignments.A1.lastDispatchAt = now - 120_000;

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ minResendIntervalMs: 0 }),
      now,
    });

    // Should not dispatch while in backoff
    expect(outcome.actions.length).toBe(0);
  });

  it("escalates after max retries exceeded", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "stalled";
    store.assignments.A1.retryCount = 5;
    store.assignments.A1.lastDispatchAt = now - 120_000;
    store.assignments.A1.deliveryContext = { channel: "discord", to: "user123" };

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ maxRetries: 2, minResendIntervalMs: 0 }),
      now,
    });

    expect(outcome.actions.length).toBe(1);
    expect(outcome.actions[0].type).toBe("escalate");
  });

  it("uses recoveryPolicy when set", () => {
    const now = Date.now();
    const store = buildStore(now);
    store.assignments.A1.status = "stalled";
    store.assignments.A1.retryCount = 5;
    store.assignments.A1.recoveryPolicy = "reassign";
    store.assignments.A1.lastDispatchAt = now - 120_000;

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: { assignmentId: "A1", sessionKey: "agent:main" },
      },
    };

    const outcome = reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ maxRetries: 2, minResendIntervalMs: 0 }),
      now,
    });

    expect(outcome.actions.length).toBe(1);
    expect(outcome.actions[0].type).toBe("spawn");
  });
});

describe("reconcileOverseerState rollups", () => {
  it("rolls up subtask completion to task", () => {
    const now = Date.now();
    const store = buildStore(now);
    // Mark first subtask as done via structured update
    store.goals.goal_1.plan!.phases[0].tasks[0].subtasks[0].status = "done";

    const telemetry: OverseerTelemetrySnapshot = {
      ts: now,
      assignments: {
        A1: {
          assignmentId: "A1",
          sessionKey: "agent:main",
          structuredUpdate: {
            workNodeId: "S1.1.1",
            status: "done",
          },
        },
      },
    };

    reconcileOverseerState({
      store,
      telemetry,
      cfg: buildCfg({ idleAfterMs: 60_000 }),
      now,
    });

    // Task should be marked done since all subtasks are done
    expect(store.goals.goal_1.plan!.phases[0].tasks[0].status).toBe("done");
    // Phase should be marked done since all tasks are done
    expect(store.goals.goal_1.plan!.phases[0].status).toBe("done");
    // Goal should be completed since all phases are done
    expect(store.goals.goal_1.status).toBe("completed");
  });
});
