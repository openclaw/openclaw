import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return {
    ...actual,
    createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
  };
});

import { getRuntimeConfig } from "../config/config.js";
import { formatGatewayPendingCloseSteps } from "./restart-trace.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { createPlacementFailureActions } from "./worker-environments/placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./worker-environments/placement-dispatch-recovery.js";
import { seedStartingPlacement } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as workerEnvironmentSupport from "./worker-environments/service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./worker-environments/workspace-recovery.test-support.js";

async function preservedSessionKeys() {
  const prepared = await prepareSessionMaintenancePreservation("unused-store");
  try {
    return new Set(prepared.capture().providerKeys);
  } finally {
    prepared.dispose();
  }
}

describe("worker placement startup cleanup ownership", () => {
  workerEnvironmentSupport.setupWorkerEnvironmentServiceSuite();

  it("settles an accepted retirement and stops before the next reconciliation candidate", async ({
    signal,
  }) => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider(),
      { scheduler },
    );
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
    });
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "absent");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      invalidate: vi.fn(),
      nextSweepAtMs: () => Infinity,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      initialPlacements: [],
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    if (!sidecar) {
      throw new Error("worker placement runtime did not start");
    }
    await time.advanceBy(60_000);
    for (const sessionId of ["shutdown-first", "shutdown-next"]) {
      await placements.startDispatch({
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        agentId: "main",
      });
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let acceptedSignal: AbortSignal | undefined;
    let retirementDispatches = 0;
    const recording = probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (command.type === "workerPlacements.retire") {
        retirementDispatches++;
        acceptedSignal = getAsyncWorkSignal();
        entered.resolve();
        await release.promise;
      }
      return scope.execute(command, executeOptions);
    });
    let stopping: Promise<void> | undefined;
    let sweeping: void | Promise<void>;
    try {
      sweeping = time.advanceBy(60_000);
      await withinTest(entered.promise, signal);
      let stopped = false;
      stopping = sidecar.stop().then(() => {
        stopped = true;
      });
      const pending = formatGatewayPendingCloseSteps();
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(acceptedSignal?.aborted).toBe(false);
      release.resolve();
      await withinTest(Promise.all([stopping, sweeping]), signal);
      expect(await placements.getAsync("shutdown-first")).toBeUndefined();
      expect(await placements.getAsync("shutdown-next")).toMatchObject({ state: "requested" });
      expect(retirementDispatches).toBe(1);
      expect(pending).toContain("shutdown.worker-placement.reconcile.session-retirement=");
    } finally {
      release.resolve();
      await (stopping ?? sidecar.stop());
      recording.mockRestore();
      await scheduler.stop();
    }
  });

  it("aborts in-flight inspection before joining placement reconciliation and retains producer custody", async () => {
    await workerEnvironmentSupport.seedReadyNodeDesktop("worker-close-inspection");
    const inspectionStarted = createDeferredCore();
    const producerSettled = createDeferredCore();
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    let holdInspection = false;
    let inspectionSignal: AbortSignal | undefined;
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider({
        inspect: async ({ signal }) => {
          if (holdInspection) {
            inspectionSignal = signal;
            inspectionStarted.resolve();
            await producerSettled.promise;
          }
          return { status: "active" };
        },
      }),
      { scheduler },
    );
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
    });
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      invalidate: vi.fn(),
      nextSweepAtMs: () => Infinity,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      initialPlacements: [],
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    const sidecar = await runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: vi.fn(),
      unregisterSidecar: vi.fn(),
    });
    if (!sidecar) {
      throw new Error("worker placement runtime did not start");
    }
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      holdInspection = true;
      void time.advanceBy(60_000);
      await inspectionStarted.promise;
      stopping = sidecar.stop().then(() => {
        stopped = true;
      });
      expect(inspectionSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(workerEnvironmentSupport.testState.store.get("worker-close-inspection")).toMatchObject(
        {
          state: "ready",
          leaseId: "lease:worker-close-inspection",
        },
      );
      producerSettled.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      producerSettled.resolve();
      await (stopping ?? sidecar?.stop());
      await scheduler.stop();
    }
  });

  it("defers workspace cleanup for 50 failed placements until the first background sweep", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
      now: () => workerEnvironmentSupport.testState.nowMs,
    });
    for (let index = 0; index < 50; index += 1) {
      const requested = await placements.startDispatch({
        sessionId: `session-debris-${index}`,
        sessionKey: `agent:main:debris-${index}`,
        agentId: "main",
        executionMode: "worker-turn",
      });
      const provisioning = await placements.transition({
        sessionId: requested.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: `worker-debris-${index}` },
      });
      await placements.fail({
        sessionId: requested.sessionId,
        expectedGeneration: provisioning.generation,
        recoveryError: "worker admission deadline exceeded",
      });
    }
    const before = await placements.listAsync();
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider(),
    );
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const resolveWorkspace = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      return {
        kind: "local" as const,
        path: path.join(workerEnvironmentSupport.testState.root, sessionId),
      };
    });
    const recovery = createPlacementRecoveryActions(
      {
        placements,
        environments,
        failure: createPlacementFailureActions({ placements, environments }),
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        ...createWorkerWorkspaceRecoveryFixture({ resolveWorkspace }),
      },
      before,
    );
    const starting = recovery.reconcile("startup");
    let sweeping: Promise<void> | undefined;
    try {
      expect(
        await Promise.race([
          starting.then(() => "ready"),
          cleanupStarted.promise.then(() => "cleanup"),
        ]),
      ).toBe("ready");
      expect(resolveWorkspace).not.toHaveBeenCalled();
      await recovery.reconcileActive("worker-debris-0");
      expect(resolveWorkspace).not.toHaveBeenCalled();

      sweeping = recovery.reconcileActive();
      await cleanupStarted.promise;
      expect(resolveWorkspace).toHaveBeenCalledOnce();
      releaseCleanup.resolve();
      await sweeping;
      expect(resolveWorkspace).toHaveBeenCalledTimes(50);
      await recovery.reconcileActive();
      expect(resolveWorkspace).toHaveBeenCalledTimes(50);
      expect(await placements.listAsync()).toEqual(before);
    } finally {
      releaseCleanup.resolve();
      await starting;
      await sweeping;
    }
  });

  it.each([
    { retainedAuthority: "a local turn claim", claimLocalTurn: true },
    { retainedAuthority: "an active owner epoch", claimLocalTurn: false },
  ])(
    "never reaches worker providers during startup while a failed placement retains $retainedAuthority",
    async ({ claimLocalTurn }) => {
      const environmentId = "worker-startup-fenced";
      const provision = vi.fn(async () => ({
        leaseId: "lease-startup-fenced",
        ssh: workerEnvironmentSupport.SSH_ENDPOINT,
      }));
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const destroy = vi.fn(async () => {});
      const environments = workerEnvironmentSupport.createService(
        workerEnvironmentSupport.createProvider({ provision, inspect, destroy }),
      );
      const requestedEnvironment = await workerEnvironmentSupport.testState.store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: "provision:startup-fenced",
      });
      await workerEnvironmentSupport.testState.store.transition({
        environmentId,
        from: requestedEnvironment.state,
        to: "provisioning",
      });
      await workerEnvironmentSupport.testState.store.requestDestroy({
        environmentId,
        state: "provisioning",
      });
      const placements = createWorkerSessionPlacementStore({
        database: workerEnvironmentSupport.testState.stateDb,
        now: () => workerEnvironmentSupport.testState.nowMs,
      });
      let failed;
      if (claimLocalTurn) {
        const identity = {
          sessionId: "session-startup-fenced",
          sessionKey: "agent:main:startup-fenced",
          agentId: "main",
        };
        await placements.claimTurn({
          ...identity,
          owner: { kind: "local" },
          claimId: "startup-fenced-local-claim",
          runId: "startup-fenced-local-run",
        });
        const requested = await placements.startDispatch({
          ...identity,
          executionMode: "remote-exec",
        });
        failed = await placements.fail({
          sessionId: requested.sessionId,
          expectedGeneration: requested.generation,
          recoveryError: "startup worker placement failed before its local claim was released",
        });
        // Current dispatch binds environments only after its local turn drains; preserve a
        // crash-era terminal environment reference in SQLite without fabricating record shapes.
        workerEnvironmentSupport.testState.stateDb.db
          .prepare("UPDATE worker_session_placements SET environment_id = ? WHERE session_id = ?")
          .run(environmentId, failed.sessionId);
        // This crash-era fixture bypasses receipts, so reload the durable row explicitly.
        failed = (await placements.getWithMoveAsync(failed.sessionId)).placement;
      } else {
        const starting = await seedStartingPlacement(placements, environmentId, "remote-exec");
        failed = await placements.fail({
          sessionId: starting.sessionId,
          expectedGeneration: starting.generation,
          recoveryError: "startup worker placement failed before its owner epoch was released",
        });
        // Preserve crash-era ownership; current activation rejects this destroying allocation.
        workerEnvironmentSupport.testState.stateDb.db
          .prepare(
            "UPDATE worker_session_placements SET active_owner_epoch = 1 WHERE session_id = ?",
          )
          .run(failed.sessionId);
        // This crash-era fixture bypasses receipts, so reload the durable row explicitly.
        failed = (await placements.getWithMoveAsync(failed.sessionId)).placement;
      }
      expect(failed).toMatchObject({
        state: "failed",
        environmentId,
        activeOwnerEpoch: claimLocalTurn ? null : 1,
        turnClaim: claimLocalTurn ? expect.objectContaining({ owner: "local" }) : null,
      });
      const failedSessionKey = failed?.sessionKey;
      if (!failedSessionKey) {
        throw new Error("failed placement fixture is missing its session key");
      }
      runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
      runtimeFactoryMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: vi.fn(() => 0),
        invalidate: vi.fn(),
        nextSweepAtMs: () => Infinity,
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      const runtime = createGatewayWorkerPlacementRuntime({
        initialPlacements: await placements.listAsync(),
        scheduler: createTestGatewayScheduler(),
        getCommittedRuntimeConfig: getRuntimeConfig,
        cancelSessionWork: vi.fn(async () => {}),
        placements,
        environments,
        gatewayNamespace: "gateway-test",
        revokeSessionAuthority: vi.fn(),
        warn: vi.fn(),
      });
      const sidecar = await runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar: vi.fn(),
        unregisterSidecar: vi.fn(),
      });
      try {
        expect(sidecar).not.toBeNull();
        expect((await preservedSessionKeys()).has(failedSessionKey)).toBe(true);
        await environments.reconcileOnce();
        expect(provision).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
          state: "provisioning",
          leaseId: null,
          destroyRequestedAtMs: expect.any(Number),
        });
        await workerEnvironmentSupport.testState.store.transition({
          environmentId,
          from: "provisioning",
          to: "failed",
        });
        expect((await preservedSessionKeys()).has(failedSessionKey)).not.toBe(true);
      } finally {
        await sidecar?.stop();
      }
      expect((await preservedSessionKeys()).has(failedSessionKey)).not.toBe(true);
    },
  );

  it("becomes ready before failed-placement lease adoption and drains its exact teardown", async () => {
    const environmentId = "worker-startup-indeterminate";
    const operationId = "provision:startup-indeterminate";
    const releaseResolution = createDeferredCore();
    const resolutionStarted = createDeferredCore();
    const resolveAllocation = vi.fn(async () => {
      resolutionStarted.resolve();
      await releaseResolution.promise;
      return { leaseId: "lease-startup-adopted", sharedHost: false };
    });
    const provision = vi.fn();
    const destroy = vi.fn(async () => {});
    const environments = workerEnvironmentSupport.createService(
      workerEnvironmentSupport.createProvider({ provision, resolveAllocation, destroy }),
    );
    const intent = await workerEnvironmentSupport.testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: operationId,
    });
    await workerEnvironmentSupport.testState.store.transition({
      environmentId,
      from: intent.state,
      to: "provisioning",
    });
    await workerEnvironmentSupport.testState.store.requestDestroy({
      environmentId,
      state: "provisioning",
    });
    const placements = createWorkerSessionPlacementStore({
      database: workerEnvironmentSupport.testState.stateDb,
      now: () => workerEnvironmentSupport.testState.nowMs,
    });
    const requested = await placements.startDispatch({
      sessionId: "session-startup-indeterminate",
      sessionKey: "agent:main:startup-indeterminate",
      agentId: "main",
      executionMode: "remote-exec",
    });
    const provisioning = await placements.transition({
      sessionId: requested.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId },
    });
    const failed = await placements.fail({
      sessionId: provisioning.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "startup worker placement failed",
    });
    expect(failed).toMatchObject({
      state: "failed",
      environmentId,
      turnClaim: null,
      activeOwnerEpoch: null,
    });
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      invalidate: vi.fn(),
      nextSweepAtMs: () => Infinity,
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    const runtime = createGatewayWorkerPlacementRuntime({
      initialPlacements: await placements.listAsync(),
      scheduler: createTestGatewayScheduler(),
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      revokeSessionAuthority: vi.fn(),
      warn: vi.fn(),
    });
    let registeredSidecar: { stop: () => Promise<void> } | undefined;
    const starting = runtime.startRuntime({
      isClosePreludeStarted: () => false,
      registerSidecar: (sidecar) => {
        registeredSidecar = sidecar;
      },
      unregisterSidecar: vi.fn(),
    });

    try {
      const first = await Promise.race([
        starting.then((sidecar) => ({ kind: "ready" as const, sidecar })),
        resolutionStarted.promise.then(() => ({ kind: "resolution" as const })),
      ]);
      expect(first.kind).toBe("ready");
      if (first.kind !== "ready" || !first.sidecar) {
        throw new Error("worker startup did not reach readiness before provider adoption");
      }
      await resolutionStarted.promise;
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith({ region: "test" }, operationId);
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });

      let stopped = false;
      const stopping = first.sidecar.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(destroy).not.toHaveBeenCalled();

      releaseResolution.resolve();
      await stopping;

      expect(provision).not.toHaveBeenCalled();
      expect(workerEnvironmentSupport.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(workerEnvironmentSupport.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "lease-startup-adopted",
        profile: { region: "test" },
      });
      expect(workerEnvironmentSupport.testState.store.get(environmentId)).toMatchObject({
        state: "destroyed",
        leaseId: "lease-startup-adopted",
      });
    } finally {
      releaseResolution.resolve();
      await starting.catch(() => undefined);
      await registeredSidecar?.stop();
    }
  });
});
