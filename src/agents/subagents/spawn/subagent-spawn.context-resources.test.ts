import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
} from "../../../context-engine/registry.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import {
  loadSubagentSpawnModuleForTest,
  createSubagentSpawnTestConfig,
} from "./subagent-spawn.test-helpers.js";

function createEngineFixture(
  prepare?: ContextEngine["prepareSubagentSpawn"],
  dispose?: () => Promise<void>,
) {
  const registry = createEmptyPluginRegistry();
  const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
  resources.attach(registry);
  const database = new DatabaseSync(":memory:");
  const read = () => expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
  const retired = vi.fn(() => database.close());
  resources.register("fixture", { id: "native", dispose: retired });
  const engineDisposal = vi.fn(async () => {
    read();
    await dispose?.();
  });
  const raw: ContextEngine = Object.assign(new LegacyContextEngine(), {
    prepareSubagentSpawn: prepare,
    dispose: engineDisposal,
  });
  registerContextEngineInRegistry(registry, "legacy", () => raw, "core");
  let engine: ContextEngine | undefined;
  return {
    database,
    read,
    retired,
    engineDisposal,
    async resolve() {
      engine = await withPluginRuntimeRegistryScope(registry, () => resolveContextEngine());
      // The spawn now owns the only remaining physical claim.
      await resources.release();
      return engine;
    },
    async cleanup() {
      await engine?.dispose?.().catch(() => {});
      await resources.release();
    },
  };
}

describe("spawn context-engine resource custody", () => {
  const callGateway = vi.fn();
  const resolveEngine = vi.fn();
  const completeLaunchCleanup = vi.fn();
  const settleLaunchFailure = vi.fn();
  const registerRun = vi.fn();
  const config = createSubagentSpawnTestConfig(undefined, {
    tools: { swarm: { enabled: true, maxConcurrent: 1 } },
  });
  let spawn: typeof import("./subagent-spawn.js").spawnSubagentDirect;
  let scheduler: typeof import("../swarm/swarm-scheduler.js");
  let resetScheduler: () => void;
  let GatewayDrainingError: typeof import("../../../process/gateway-work-admission.js").GatewayDrainingError;

  beforeAll(async () => {
    ({ spawnSubagentDirect: spawn } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: callGateway,
      resolveContextEngineMock: resolveEngine,
      ensureContextEnginesInitializedMock: () => {},
      completeCollectorLaunchCleanupMock: completeLaunchCleanup,
      settleFailedQueuedSubagentLaunchMock: settleLaunchFailure,
      registerSubagentRunMock: registerRun,
      getRuntimeConfig: () => config,
    }));
    scheduler = await import("../swarm/swarm-scheduler.js");
    ({
      testing: { reset: resetScheduler },
    } = await import("../swarm/swarm-scheduler.test-support.js"));
    ({ GatewayDrainingError } = await import("../../../process/gateway-work-admission.js"));
  });

  beforeEach(() => {
    callGateway
      .mockReset()
      .mockImplementation(async (request: { method?: string; params?: Record<string, unknown> }) =>
        request.method === "agent"
          ? { runId: request.params?.idempotencyKey, status: "accepted" }
          : { ok: true },
      );
    resolveEngine.mockReset();
    completeLaunchCleanup.mockReset();
    settleLaunchFailure.mockReset();
    registerRun.mockReset();
    resetScheduler();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    resetScheduler();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    "success",
    "absent-hook",
    "prepare-failure",
    "stale-resolution",
    "dispatch-failure",
    "rollback-failure",
  ] as const)("retires the resolved engine after %s", async (mode) => {
    let current = true;
    const resolved = createDeferred();
    const resolutionGate = createDeferred();
    const rollback = vi.fn(async () => {
      fixture.read();
      if (mode === "rollback-failure") {
        throw new Error("rollback failed");
      }
    });
    const fixture = createEngineFixture(
      mode === "absent-hook"
        ? undefined
        : async () => {
            fixture.read();
            if (mode === "prepare-failure") {
              throw new Error("preparation failed");
            }
            return { rollback };
          },
    );
    resolveEngine.mockImplementation(async () => {
      const engine = await fixture.resolve();
      resolved.resolve();
      if (mode === "stale-resolution") {
        await resolutionGate.promise;
      }
      return engine;
    });
    callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        fixture.read();
        if (mode === "dispatch-failure" || mode === "rollback-failure") {
          throw new Error("launch failed");
        }
        return { runId: "child", status: "accepted" };
      }
      return { ok: true };
    });
    const operation = spawn(
      { task: "synthetic child" },
      {
        agentSessionKey: "main",
        assertActive() {
          if (!current) {
            throw new Error("parent closed");
          }
        },
      },
    );
    try {
      await resolved.promise;
      if (mode === "stale-resolution") {
        current = false;
      }
      resolutionGate.resolve();
      const result = await operation;
      expect(result.status).toBe(
        mode === "success" || mode === "absent-hook" ? "accepted" : "error",
      );
      if (mode === "dispatch-failure" || mode === "rollback-failure") {
        expect(result.error).toBe("launch failed");
        expect(rollback).toHaveBeenCalledTimes(1);
      }
      expect(fixture.retired).toHaveBeenCalledTimes(1);
      expect(fixture.engineDisposal).toHaveBeenCalledTimes(1);
      expect(fixture.database.isOpen).toBe(false);
    } finally {
      resolutionGate.resolve();
      await operation;
      await fixture.cleanup();
    }
  });

  it.each(["success", "failure"] as const)(
    "awaits asynchronous disposal without replacing %s",
    async (mode) => {
      const disposalStarted = createDeferred();
      const disposalGate = createDeferred();
      const fixture = createEngineFixture(undefined, async () => {
        disposalStarted.resolve();
        await disposalGate.promise;
        if (mode === "failure") {
          throw new Error("cleanup failed");
        }
      });
      resolveEngine.mockImplementation(() => fixture.resolve());
      if (mode === "failure") {
        callGateway.mockImplementation(async (request: { method?: string }) => {
          if (request.method === "agent") {
            throw new Error("launch failed");
          }
          return { ok: true };
        });
      }
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let settled = false;
      const operation = spawn({ task: "synthetic child" }, { agentSessionKey: "main" }).finally(
        () => {
          settled = true;
        },
      );
      try {
        // A task turn also completes on the original defect, without entering cleanup.
        await Promise.race([disposalStarted.promise, operation]);
        expect.soft(settled).toBe(false);
        expect.soft(fixture.database.isOpen).toBe(true);
        disposalGate.resolve();
        const result = await operation;
        expect(result.status).toBe(mode === "success" ? "accepted" : "error");
        if (mode === "failure") {
          expect(result.error).toBe("launch failed");
        }
        expect(fixture.retired).toHaveBeenCalledTimes(1);
      } finally {
        disposalGate.resolve();
        await operation;
        await fixture.cleanup();
      }
    },
  );

  it("rolls back a reservation withdrawn before scheduler activation", async () => {
    let childPrepared = false;
    const rollback = vi.fn(async () => {
      fixture.read();
      childPrepared = false;
    });
    const fixture = createEngineFixture(async () => {
      childPrepared = true;
      return { rollback };
    });
    resolveEngine.mockImplementation(() => fixture.resolve());
    registerRun.mockImplementation(({ runId }: { runId: string }) => {
      expect(scheduler.removeQueuedSwarmRun(runId)).toBe(true);
    });
    try {
      await expect(
        spawn(
          { task: "withdrawn child", collect: true, groupId: "withdrawn-group" },
          { agentSessionKey: "main" },
        ),
      ).rejects.toThrow("swarm scheduler reservation missing");
      expect(childPrepared).toBe(false);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(fixture.engineDisposal).toHaveBeenCalledTimes(1);
      expect(fixture.retired).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    "success",
    "failure",
    "rollback-failure",
    "disposal-failure",
    "draining",
    "retired-draining",
    "withdrawal",
  ] as const)("keeps queued preparation alive until %s finishes", async (mode) => {
    const blockerStarted = createDeferred();
    const retryStarted = createDeferred();
    const retryGate = createDeferred();
    const disposalGate = createDeferred();
    const disposalStarted = createDeferred();
    const launchWork = new AsyncWorkScope();
    const rollback = vi.fn(async () => {
      fixture.read();
      if (mode === "rollback-failure") {
        throw new Error("rollback failed");
      }
    });
    const fixture = createEngineFixture(
      async () => {
        fixture.read();
        return { rollback };
      },
      async () => {
        disposalStarted.resolve();
        if (mode === "withdrawal") {
          await disposalGate.promise;
        }
        if (mode === "disposal-failure") {
          throw new Error("engine cleanup failed");
        }
      },
    );
    resolveEngine.mockImplementation(() => fixture.resolve());
    let launches = 0;
    callGateway.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method !== "agent") {
          return { ok: true };
        }
        fixture.read();
        launches++;
        if (mode === "failure" || mode === "rollback-failure" || mode === "disposal-failure") {
          throw new Error("launch failed");
        }
        if (mode === "retired-draining") {
          retryStarted.resolve();
          await retryGate.promise;
          fixture.read();
          throw new GatewayDrainingError();
        }
        if (mode === "draining") {
          if (launches === 1) {
            throw new GatewayDrainingError();
          }
          retryStarted.resolve();
          await retryGate.promise;
          fixture.read();
        }
        return { runId: request.params?.idempotencyKey, status: "accepted" };
      },
    );
    scheduler.enqueueSwarmRun({
      groupId: JSON.stringify(["main", "main", "resource-group"]),
      runId: "blocker",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => blockerStarted.resolve(),
      onStartFailure: () => true,
    });
    await blockerStarted.promise;
    let queuedRunId: string | undefined;
    try {
      const result = await spawn(
        { task: "synthetic queued child", collect: true, groupId: "resource-group" },
        { agentSessionKey: "main" },
      );
      expect(result.status).toBe("accepted");
      queuedRunId = result.runId;
      expect(fixture.database.isOpen).toBe(true);
      expect(launches).toBe(0);
      if (mode === "withdrawal") {
        const hold = scheduler.holdQueuedSwarmRun(result.runId!);
        expect(hold?.withdraw()).toBe(true);
        let released = false;
        const release = Promise.resolve(hold?.release()).then(() => {
          released = true;
        });
        await Promise.race([disposalStarted.promise, release]);
        expect.soft(released).toBe(false);
        expect(fixture.database.isOpen).toBe(true);
        disposalGate.resolve();
        await release;
      } else {
        if (mode === "retired-draining") {
          launchWork.run(() => scheduler.releaseSwarmRun("blocker"));
        } else {
          scheduler.releaseSwarmRun("blocker");
        }
        if (mode === "draining" || mode === "retired-draining") {
          await retryStarted.promise;
          expect(fixture.database.isOpen).toBe(true);
          expect(rollback).not.toHaveBeenCalled();
          if (mode === "retired-draining") {
            await launchWork.drain();
            expect(scheduler.releaseSwarmRun(result.runId!)).toBe(true);
            expect(fixture.database.isOpen).toBe(true);
          }
          retryGate.resolve();
        }
        await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalledTimes(1));
      }
      expect(fixture.retired).toHaveBeenCalledTimes(1);
      expect(fixture.engineDisposal).toHaveBeenCalledTimes(1);
      if (mode === "failure" || mode === "rollback-failure" || mode === "disposal-failure") {
        await vi.waitFor(() => expect(settleLaunchFailure).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completeLaunchCleanup).toHaveBeenCalledTimes(mode === "failure" ? 1 : 0);
      }
      expect(rollback).toHaveBeenCalledTimes(
        mode === "failure" ||
          mode === "rollback-failure" ||
          mode === "disposal-failure" ||
          mode === "withdrawal" ||
          mode === "retired-draining"
          ? 1
          : 0,
      );
    } finally {
      retryGate.resolve();
      disposalGate.resolve();
      if (queuedRunId) {
        scheduler.removeQueuedSwarmRun(queuedRunId);
      }
      await fixture.cleanup();
      await launchWork.drain();
    }
  });
});
