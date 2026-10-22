import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import type { SubagentRegistrationScope } from "../registry/subagent-registry.types.js";
import {
  loadSubagentSpawnModuleForTest,
  createSubagentSpawnTestConfig,
  createSubagentRegistrationScopeForTest,
} from "./subagent-spawn.test-helpers.js";

let LegacyContextEngine: typeof import("../../../context-engine/legacy.js").LegacyContextEngine;
let registerContextEngineInRegistry: typeof import("../../../context-engine/registry.js").registerContextEngineInRegistry;
let resolveContextEngine: typeof import("../../../context-engine/registry.js").resolveContextEngine;
let createEmptyPluginRegistry: typeof import("../../../plugins/registry-empty.js").createEmptyPluginRegistry;
let PluginRegistryInspectionResources: typeof import("../../../plugins/registry-inspection-resources.js").PluginRegistryInspectionResources;
let retireInspectionInstances: typeof import("../../../plugins/registry-inspection.test-support.js").retireInspectionInstances;
let withPluginRuntimeRegistryScope: typeof import("../../../plugins/runtime/gateway-request-scope.js").withPluginRuntimeRegistryScope;
let AsyncWorkScope: typeof import("../../../shared/async-work-scope.js").AsyncWorkScope;

function createGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

function createEngineFixture(
  options: {
    mode?: string;
    dispose?: () => Promise<void>;
    beforeNativeCleanup?: () => Promise<void>;
  } = {},
) {
  const registry = createEmptyPluginRegistry();
  const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
  resources.attach(registry);
  const database = new DatabaseSync(":memory:");
  const read = () => expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
  const rollback = vi.fn(async () => {
    read();
    if (options.mode === "rollback-failure") {
      throw new Error("rollback failed");
    }
  });
  const retired = vi.fn(() => database.close());
  resources.runRegistration(
    "fixture",
    () => resources.register("fixture", { id: "native", dispose: retired }),
    async (runCleanup) => {
      await options.beforeNativeCleanup?.();
      await runCleanup();
    },
  );
  const engineDisposal = vi.fn(async () => {
    read();
    await options.dispose?.();
  });
  const raw: ContextEngine = Object.assign(new LegacyContextEngine(), {
    prepareSubagentSpawn:
      options.mode !== "no-prepare"
        ? async () => {
            read();
            if (options.mode === "prepare-failure") {
              throw new Error("preparation failed");
            }
            return { rollback };
          }
        : undefined,
    dispose: engineDisposal,
  });
  registerContextEngineInRegistry(registry, "legacy", () => raw, "core");
  let engine: ContextEngine | undefined;
  return {
    database,
    read,
    retired,
    rollback,
    engineDisposal,
    expectClosed() {
      expect(retired).toHaveBeenCalledOnce();
      expect(engineDisposal).toHaveBeenCalledOnce();
      expect(database.isOpen).toBe(false);
    },
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
  let expectedCloseFailure: unknown;
  let GatewayDrainingError: typeof import("../../../process/gateway-work-admission.js").GatewayDrainingError;
  type Request = { method?: string; params?: Record<string, unknown> };
  function handleAgent(handle: (request: Request) => Promise<unknown>) {
    callGateway.mockImplementation(async (request: Request) =>
      request.method === "agent" ? handle(request) : { ok: true },
    );
  }
  function engineFixture(options?: Parameters<typeof createEngineFixture>[0]) {
    const fixture = createEngineFixture(options);
    resolveEngine.mockImplementation(() => fixture.resolve());
    return fixture;
  }
  const requester = { agentSessionKey: "main" };
  const spawnChild = (groupId?: string) =>
    spawn({ task: "synthetic child", ...(groupId ? { collect: true, groupId } : {}) }, requester);

  beforeEach(async () => {
    expectedCloseFailure = undefined;
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
    ({ LegacyContextEngine } = await import("../../../context-engine/legacy.js"));
    ({ registerContextEngineInRegistry, resolveContextEngine } =
      await import("../../../context-engine/registry.js"));
    ({ createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js"));
    ({ PluginRegistryInspectionResources } =
      await import("../../../plugins/registry-inspection-resources.js"));
    ({ retireInspectionInstances } =
      await import("../../../plugins/registry-inspection.test-support.js"));
    ({ withPluginRuntimeRegistryScope } =
      await import("../../../plugins/runtime/gateway-request-scope.js"));
    ({ AsyncWorkScope } = await import("../../../shared/async-work-scope.js"));
    ({ GatewayDrainingError } = await import("../../../process/gateway-work-admission.js"));
  });

  beforeEach(() => {
    callGateway.mockReset();
    handleAgent(async (request) => ({ runId: request.params?.idempotencyKey, status: "accepted" }));
    resolveEngine.mockReset();
    completeLaunchCleanup.mockReset();
    settleLaunchFailure.mockReset();
    registerRun.mockReset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(async () => {
    try {
      try {
        await scheduler.closeSwarmScheduler();
      } catch (error) {
        if (expectedCloseFailure === undefined) {
          throw error;
        }
        expect(error).toEqual(expectedCloseFailure);
      }
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it.each(["registration", "claim"] as const)(
    "joins preactivation resource cleanup without awaiting the public spawn's %s",
    async (blockedOn) => {
      const registered = createDeferred<string>();
      const registrationGate = createDeferred();
      const claim = createGate();
      const disposal = createGate();
      let claimed = true;
      const fixture = engineFixture({ dispose: disposal.wait });
      const scope = createSubagentRegistrationScopeForTest({
        waitForClaim: () => (claimed ? claim.wait() : undefined),
        canLaunch: () => false,
        canAbortAcceptedRun: () => false,
        canRetireReservation: () => false,
        settleFailedLaunch: vi.fn(async () => {}),
      });
      registerRun.mockImplementation(
        async (
          { runId }: { runId: string },
          options: { retainOwnership: (scope: SubagentRegistrationScope) => void },
        ) => {
          options.retainOwnership(scope);
          registered.resolve(runId);
          await registrationGate.promise;
        },
      );
      const operation = spawnChild("owned-preparation");
      const runId = await registered.promise;
      const cancellation = scheduler.holdQueuedSwarmRun(runId)!;
      try {
        if (blockedOn === "claim") {
          registrationGate.resolve();
          await claim.entered;
        }
        expect(cancellation.withdraw()).toBe(true);
        const publication = vi.fn();
        const settlement = cancellation.settleCancellation().then((qualified) => {
          if (qualified) {
            publication();
          }
          return qualified;
        });
        await disposal.entered;
        fixture.read();
        expect(publication).not.toHaveBeenCalled();
        expect(fixture.retired).not.toHaveBeenCalled();
        disposal.release();
        expect(await settlement).toBe(true);
        fixture.expectClosed();
        expect(fixture.rollback).toHaveBeenCalledOnce();
        expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
      } finally {
        disposal.release();
        registrationGate.resolve();
        claimed = false;
        claim.release();
        await cancellation.release();
        await operation;
        await fixture.cleanup();
      }
    },
  );

  it.each(["prepare-failure", "stale-resolution", "rollback-failure"] as const)(
    "retires the resolved engine after %s",
    async (mode) => {
      let current = true;
      const resolved = createDeferred();
      const resolutionGate = createDeferred();
      const fixture = engineFixture({ mode });
      resolveEngine.mockImplementation(async () => {
        const engine = await fixture.resolve();
        resolved.resolve();
        if (mode === "stale-resolution") {
          await resolutionGate.promise;
        }
        return engine;
      });
      handleAgent(async () => {
        fixture.read();
        if (mode === "rollback-failure") {
          throw new Error("launch failed");
        }
        return { runId: "child", status: "accepted" };
      });
      const operation = spawn(
        { task: "synthetic child" },
        {
          ...requester,
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
        expect(result.status).toBe("error");
        if (mode === "rollback-failure") {
          expect(result.error).toBe("launch failed");
          expect(fixture.rollback).toHaveBeenCalledTimes(1);
        }
        fixture.expectClosed();
      } finally {
        resolutionGate.resolve();
        await operation;
        await fixture.cleanup();
      }
    },
  );

  it("awaits asynchronous disposal without replacing the launch failure", async () => {
    const disposal = createGate();
    const fixture = engineFixture({
      mode: "no-prepare",
      dispose: async () => {
        await disposal.wait();
        throw new Error("cleanup failed");
      },
    });
    handleAgent(() => Promise.reject(new Error("launch failed")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const operation = spawnChild();
    try {
      // A task turn also completes on the original defect, without entering cleanup.
      await awaitGateBeforeSettlement(disposal.entered, operation, "Spawn settled before disposal");
      expect.soft(fixture.database.isOpen).toBe(true);
      disposal.release();
      expect(await operation).toMatchObject({ status: "error", error: "launch failed" });
      expect(fixture.retired).toHaveBeenCalledTimes(1);
    } finally {
      disposal.release();
      await operation;
      await fixture.cleanup();
    }
  });

  it.each(["success", "failure"] as const)(
    "keeps the scheduler slot when native preparation cleanup is retained after %s",
    async (outcome) => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const nativeCleanup = createGate();
      const fixture = engineFixture({
        beforeNativeCleanup: async () => {
          await nativeCleanup.wait();
          throw new Error("host cleanup could not reach the native closer");
        },
      });
      if (outcome === "failure") {
        handleAgent(() => Promise.reject(new Error("launch failed")));
      }
      try {
        const result = await spawnChild("retained-preparation");
        expect(result.status).toBe("accepted");
        await nativeCleanup.entered;
        expect(fixture.database.isOpen).toBe(true);
        nativeCleanup.release();
        await vi.advanceTimersByTimeAsync(0);

        expect(scheduler.isSwarmRunActive(result.runId!)).toBe(true);
        expect(fixture.retired).not.toHaveBeenCalled();
        expect(completeLaunchCleanup).not.toHaveBeenCalled();
        expect(settleLaunchFailure).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
        expect(fixture.rollback).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
        expect(
          callGateway.mock.calls.filter(([request]) => request.method === "agent"),
        ).toHaveLength(1);
        if (outcome === "success") {
          expect(callGateway.mock.calls.map(([request]) => request.method)).toEqual(["agent"]);
          expect(scheduler.releaseSwarmRun(result.runId!)).toBe(true);
        }
        await expect(
          scheduler.closeSwarmScheduler().catch((error: unknown) => {
            expectedCloseFailure = error;
            throw error;
          }),
        ).rejects.toThrow("Swarm launch cleanup failed");
        await expect(
          scheduler.closeSwarmScheduler().catch((error: unknown) => {
            expectedCloseFailure = error;
            throw error;
          }),
        ).rejects.toThrow("Swarm launch cleanup failed");
      } finally {
        nativeCleanup.release();
        await scheduler.closeSwarmScheduler().catch(() => {});
        await fixture.cleanup().catch(() => {});
        // The failed host closer is memoized; retire this test-owned native handle explicitly.
        if (fixture.database.isOpen) {
          fixture.database.close();
        }
      }
    },
  );

  it.each([
    "success",
    "rollback-failure",
    "disposal-failure",
    "retired-draining",
    "withdrawal",
    "shutdown-disposal-failure",
    "shutdown-draining",
  ] as const)("keeps queued preparation alive until %s finishes", async (mode) => {
    const blockerStarted = createDeferred();
    const retry = createGate();
    const disposal = createGate();
    const launchWork = new AsyncWorkScope();
    const fixture = engineFixture({
      mode,
      dispose: async () => {
        if (mode === "withdrawal") {
          await disposal.wait();
        }
        if (mode === "disposal-failure" || mode === "shutdown-disposal-failure") {
          throw new Error("engine cleanup failed");
        }
      },
    });
    let launches = 0;
    handleAgent(async (request) => {
      fixture.read();
      launches++;
      if (mode === "rollback-failure" || mode === "disposal-failure") {
        throw new Error("launch failed");
      }
      if (mode === "retired-draining" || mode === "shutdown-draining") {
        await retry.wait();
        fixture.read();
        throw new GatewayDrainingError();
      }
      return { runId: request.params?.idempotencyKey, status: "accepted" };
    });
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
    let closing: Promise<void> | undefined;
    try {
      const result = await spawnChild("resource-group");
      expect(result.status).toBe("accepted");
      queuedRunId = result.runId;
      expect(fixture.database.isOpen).toBe(true);
      expect(launches).toBe(0);
      if (mode === "withdrawal") {
        const hold = scheduler.holdQueuedSwarmRun(result.runId!);
        expect(hold?.withdraw()).toBe(true);
        const release = Promise.resolve(hold?.release());
        await awaitGateBeforeSettlement(disposal.entered, release, "Hold released before disposal");
        expect(fixture.database.isOpen).toBe(true);
        disposal.release();
        await release;
      } else if (mode === "shutdown-disposal-failure") {
        closing = scheduler.closeSwarmScheduler();
        await expect(
          closing.catch((error: unknown) => {
            expectedCloseFailure = error;
            throw error;
          }),
        ).rejects.toThrow("Swarm launch cleanup failed");
        expect(launches).toBe(0);
        expect(settleLaunchFailure).not.toHaveBeenCalled();
      } else {
        if (mode === "retired-draining") {
          launchWork.run(() => scheduler.releaseSwarmRun("blocker"));
        } else {
          scheduler.releaseSwarmRun("blocker");
        }
        if (mode === "retired-draining" || mode === "shutdown-draining") {
          await retry.entered;
          expect(fixture.database.isOpen).toBe(true);
          expect(fixture.rollback).not.toHaveBeenCalled();
          if (mode === "retired-draining") {
            await launchWork.drain();
            expect(scheduler.releaseSwarmRun(result.runId!)).toBe(true);
            expect(fixture.database.isOpen).toBe(true);
          } else if (mode === "shutdown-draining") {
            let closed = false;
            closing = scheduler.closeSwarmScheduler().finally(() => {
              closed = true;
            });
            await Promise.resolve();
            expect(closed).toBe(false);
            expect(fixture.database.isOpen).toBe(true);
          }
          retry.release();
          await closing;
        }
        await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalledTimes(1));
      }
      fixture.expectClosed();
      if (mode === "rollback-failure" || mode === "disposal-failure") {
        await vi.waitFor(() => expect(settleLaunchFailure).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(completeLaunchCleanup).not.toHaveBeenCalled();
      }
      expect(fixture.rollback).toHaveBeenCalledTimes(
        ["rollback-failure", "disposal-failure", "withdrawal", "retired-draining"].includes(mode)
          ? 1
          : 0,
      );
    } finally {
      retry.release();
      disposal.release();
      await closing?.catch(() => {});
      if (queuedRunId) {
        const hold = scheduler.holdQueuedSwarmRun(queuedRunId);
        try {
          hold?.withdraw();
        } finally {
          await hold?.release();
        }
      }
      await fixture.cleanup();
      await launchWork.drain();
    }
  });
});
