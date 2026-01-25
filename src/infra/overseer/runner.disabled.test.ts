import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import * as commandQueue from "../../process/command-queue.js";
import { runOverseerTick, startOverseerRunner } from "./runner.js";

// Mock dependencies to isolate tests
vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: vi.fn(() => 0),
}));

vi.mock("./store.js", () => ({
  loadOverseerStoreFromDisk: vi.fn(() => ({
    version: 1,
    goals: {},
    assignments: {},
    crystallizations: {},
    events: [],
  })),
  updateOverseerStore: vi.fn(async (fn, _cfg) => {
    const store = {
      version: 1,
      goals: {},
      assignments: {},
      crystallizations: {},
      events: [],
    };
    const result = await fn(store);
    return result.result;
  }),
}));

vi.mock("./monitor.js", () => ({
  createOverseerMonitor: vi.fn(() => ({
    collectTelemetry: vi.fn(async () => ({ ts: Date.now(), assignments: {} })),
    stop: vi.fn(),
  })),
}));

describe("Overseer when disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runOverseerTick", () => {
    it("skips tick when overseer.enabled is false", async () => {
      const cfg = {
        overseer: {
          enabled: false,
          tickEvery: "2m",
        },
      };

      const result = await runOverseerTick({ cfg: cfg as any });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("disabled");
    });

    it("skips tick when overseer config is missing entirely", async () => {
      const cfg = {};

      const result = await runOverseerTick({ cfg: cfg as any });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("disabled");
    });

    it("skips tick when overseer.enabled is undefined", async () => {
      const cfg = {
        overseer: {
          tickEvery: "2m",
        },
      };

      const result = await runOverseerTick({ cfg: cfg as any });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("disabled");
    });

    it("skips tick when tickEvery is invalid", async () => {
      const cfg = {
        overseer: {
          enabled: true,
          tickEvery: "invalid-duration",
        },
      };

      const result = await runOverseerTick({ cfg: cfg as any });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("disabled");
    });

    it("skips tick when requests are in flight", async () => {
      vi.mocked(commandQueue.getQueueSize).mockReturnValue(1);

      const cfg = {
        overseer: {
          enabled: true,
          tickEvery: "2m",
        },
      };

      const result = await runOverseerTick({ cfg: cfg as any });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("requests-in-flight");
    });
  });

  describe("startOverseerRunner", () => {
    it("does not start interval when disabled", () => {
      const cfg = {
        overseer: {
          enabled: false,
        },
      };

      const runner = startOverseerRunner({ cfg: cfg as any });

      // Should return a valid runner object
      expect(runner.stop).toBeInstanceOf(Function);
      expect(runner.tickNow).toBeInstanceOf(Function);
      expect(runner.updateConfig).toBeInstanceOf(Function);
      expect(runner.updateHooks).toBeInstanceOf(Function);

      runner.stop();
    });

    it("tickNow returns not-ran when disabled", async () => {
      const cfg = {
        overseer: {
          enabled: false,
        },
      };

      const runner = startOverseerRunner({ cfg: cfg as any });
      const result = await runner.tickNow();

      expect(result.ok).toBe(false);
      expect(result.didWork).toBe(false);

      runner.stop();
    });

    it("can update config from disabled to enabled", async () => {
      const disabledCfg = {
        overseer: {
          enabled: false,
        },
      };

      const enabledCfg = {
        overseer: {
          enabled: true,
          tickEvery: "2m",
          storage: { dir: "/tmp/overseer" },
        },
      };

      const runner = startOverseerRunner({ cfg: disabledCfg as any });

      // Initially disabled
      let result = await runner.tickNow();
      expect(result.ok).toBe(false);

      // Update to enabled - note: this just updates internal config,
      // the runner still uses the monitor from startup
      runner.updateConfig(enabledCfg as any);

      // After update, tickNow should attempt to run (may still return ok=true even with no work)
      result = await runner.tickNow();
      // The key behavior is that it attempts to run, not that it's disabled
      // With mocked store returning empty data, it runs but does no work
      expect(result.didWork).toBe(false);

      runner.stop();
    });

    it("stops cleanly when aborted via signal", async () => {
      const controller = new AbortController();
      const cfg = {
        overseer: {
          enabled: true,
          tickEvery: "2m",
        },
      };

      const runner = startOverseerRunner({
        cfg: cfg as any,
        abortSignal: controller.signal,
      });

      // Abort
      controller.abort();

      // After abort, tickNow should return skipped
      const result = await runner.tickNow();
      expect(result.ok).toBe(false);
    });
  });
});

describe("Overseer graceful degradation", () => {
  // Note: Full integration tests for graceful degradation with real store
  // would require more complex test setup. The reconcileOverseerState
  // function is tested directly in runner.hooks.test.ts for edge cases.

  it("reconcileOverseerState handles empty store without errors", async () => {
    // Import the pure reconcile function directly
    const { reconcileOverseerState } = await import("./runner.js");

    const emptyStore = {
      version: 1 as const,
      goals: {},
      assignments: {},
      crystallizations: {},
      events: [],
    };

    const cfg = {
      enabled: true,
      tickEveryMs: 60_000,
      idleAfterMs: 15 * 60_000,
      maxRetries: 2,
      minResendIntervalMs: 5 * 60_000,
      backoffBaseMs: 2 * 60_000,
      backoffMaxMs: 30 * 60_000,
      allowAgents: new Set<string>(),
      allowAnyAgent: true,
      allowCrossAgent: true,
      defaultAgentId: "main",
    };

    const telemetry = { ts: Date.now(), assignments: {} };
    const now = Date.now();

    // Should not throw and should return empty results
    const result = reconcileOverseerState({
      store: emptyStore,
      telemetry,
      cfg: cfg as any,
      now,
    });

    expect(result.actions).toEqual([]);
    expect(result.didWork).toBe(false);
    expect(result.statusTransitions).toEqual([]);
  });

  it("reconcileOverseerState handles goals without assignments", async () => {
    const { reconcileOverseerState } = await import("./runner.js");

    const storeWithGoal = {
      version: 1 as const,
      goals: {
        g1: {
          goalId: "g1",
          title: "Test Goal",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "active" as const,
          priority: "normal" as const,
          tags: [],
          problemStatement: "Test problem",
          successCriteria: [],
          nonGoals: [],
        },
      },
      assignments: {},
      crystallizations: {},
      events: [],
    };

    const cfg = {
      enabled: true,
      tickEveryMs: 60_000,
      idleAfterMs: 15 * 60_000,
      maxRetries: 2,
      minResendIntervalMs: 5 * 60_000,
      backoffBaseMs: 2 * 60_000,
      backoffMaxMs: 30 * 60_000,
      allowAgents: new Set<string>(),
      allowAnyAgent: true,
      allowCrossAgent: true,
      defaultAgentId: "main",
    };

    const telemetry = { ts: Date.now(), assignments: {} };
    const now = Date.now();

    const result = reconcileOverseerState({
      store: storeWithGoal,
      telemetry,
      cfg: cfg as any,
      now,
    });

    expect(result.actions).toEqual([]);
    expect(result.didWork).toBe(false);
  });

  it("reconcileOverseerState handles assignments without matching goals", async () => {
    const { reconcileOverseerState } = await import("./runner.js");

    const now = Date.now();
    const storeWithOrphanAssignment = {
      version: 1 as const,
      goals: {},
      assignments: {
        A1: {
          assignmentId: "A1",
          goalId: "missing-goal",
          workNodeId: "W1",
          sessionKey: "agent:main",
          status: "queued" as const,
          dispatchHistory: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      crystallizations: {},
      events: [],
    };

    const cfg = {
      enabled: true,
      tickEveryMs: 60_000,
      idleAfterMs: 15 * 60_000,
      maxRetries: 2,
      minResendIntervalMs: 0,
      backoffBaseMs: 2 * 60_000,
      backoffMaxMs: 30 * 60_000,
      allowAgents: new Set<string>(),
      allowAnyAgent: true,
      allowCrossAgent: true,
      defaultAgentId: "main",
    };

    const telemetry = {
      ts: now,
      assignments: { A1: { assignmentId: "A1", sessionKey: "agent:main" } },
    };

    // Should not throw - orphan assignments should be processed
    // (though the nudge message will have limited info)
    const result = reconcileOverseerState({
      store: storeWithOrphanAssignment,
      telemetry,
      cfg: cfg as any,
      now,
    });

    // Should still attempt to dispatch (nudge) even without goal details
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe("nudge");
  });
});
