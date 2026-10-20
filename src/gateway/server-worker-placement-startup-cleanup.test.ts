import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
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
import {
  preservedSessionKeys,
  startPlacementRuntime as startRuntime,
} from "./server-worker-placement-startup.test-support.js";
import {
  createIdleDiskSpace,
  createRuntimeFactory,
} from "./server-worker-placement.test-support.js";
import { createPlacementFailureActions } from "./worker-environments/placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./worker-environments/placement-dispatch-recovery.js";
import {
  seedProvisioningPlacement,
  seedStartingPlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  createProvider,
  createService,
  seedReadyNodeDesktop,
  setupWorkerEnvironmentServiceSuite,
  SSH_ENDPOINT,
  testState,
} from "./worker-environments/service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./worker-environments/workspace-recovery.test-support.js";

const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);

const createPlacements = (fixtureClock = false) =>
  createWorkerSessionPlacementStore({
    database: testState.stateDb,
    ...(fixtureClock ? { now: () => testState.nowMs } : {}),
  });

function createEnvironments(
  provider: Parameters<typeof createProvider>[0] = {},
  options?: Parameters<typeof createService>[1],
) {
  return createService(createProvider(provider), options);
}

function failPlacement(
  store: ReturnType<typeof createPlacements>,
  placement: { sessionId: string; generation: number },
  recoveryError = "startup worker placement failed",
) {
  return store.fail({
    sessionId: placement.sessionId,
    expectedGeneration: placement.generation,
    recoveryError,
  });
}

async function requestProvisioningTeardown(environmentId: string, provisionOperationId: string) {
  const store = testState.store;
  const intent = await store.createIntent({
    environmentId,
    provisionOperationId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test" } },
  });
  await store.transition({ environmentId, from: intent.state, to: "provisioning" });
  await store.requestDestroy({ environmentId, state: "provisioning" });
}

describe("worker placement startup cleanup ownership", () => {
  setupWorkerEnvironmentServiceSuite();
  beforeEach(() => {
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
    runtimeFactoryMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
  });

  it("pauses both reconciliation schedulers during a reversible suspension", async () => {
    await seedReadyNodeDesktop("suspended-reconciliation");
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const environments = createEnvironments({ inspect }, { scheduler });
    const placements = createPlacements();
    const sidecar = await startRuntime(createRuntime({ placements, environments, scheduler }));
    await time.advanceBy(60_000);
    inspect.mockClear();
    const suspended = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspended).not.toBeNull();
    try {
      await time.advanceBy(60_000);
      await environments.reconcileOnce();
      expect(inspect).not.toHaveBeenCalled();
      suspended!.rollback();
      await time.advanceBy(60_000);
      expect(inspect).toHaveBeenCalled();
    } finally {
      suspended?.rollback();
      await sidecar.stop();
      await scheduler.stop();
    }
  });

  it("cancels a pre-existing environment inspection when restart drain begins", async () => {
    await seedReadyNodeDesktop("preexisting-reconciliation");
    const entered = createDeferredCore();
    const remote = createDeferredCore<{ status: "active" }>();
    let holdInspection = false;
    let inspectionSignal: AbortSignal | undefined;
    const environments = createEnvironments({
      inspect: async ({ signal }) => {
        if (!holdInspection) {
          return { status: "active" };
        }
        inspectionSignal = signal;
        entered.resolve();
        return racePromiseWithAbortSignal(remote.promise, signal);
      },
    });
    const placements = createPlacements();
    const sidecar = await startRuntime(createRuntime({ placements, environments }));
    holdInspection = true;
    const sweeping = environments.reconcileOnce();
    try {
      await entered.promise;
      markGatewayRestartDraining();
      expect(inspectionSignal?.aborted).toBe(true);
      await sweeping;
    } finally {
      remote.resolve({ status: "active" });
      await sweeping;
      await sidecar.stop();
      resetGatewayWorkAdmission();
    }
  });

  it("stops the active sweep before queued retention writes and candidate reads after remote cancellation", async () => {
    for (let index = 0; index < 3; index++) {
      await seedReadyNodeDesktop(`shutdown-tail-${index}`);
    }
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const entered = createDeferredCore();
    const remote = createDeferredCore<{ status: "active" }>();
    const blockedStore = createDeferredCore();
    let holdInspection = false;
    const environments = createEnvironments(
      {
        inspect: async ({ signal }) => {
          if (!holdInspection) {
            return { status: "active" };
          }
          entered.resolve();
          return racePromiseWithAbortSignal(remote.promise, signal);
        },
      },
      { scheduler },
    );
    const placements = createPlacements();
    const runtime = createRuntime({ placements, environments, scheduler });
    const sidecar = await startRuntime(runtime);
    await time.advanceBy(60_000);
    const tailEntered = createDeferredCore<string>();
    const readCandidates = placements.readRecoveryCandidates.bind(placements);
    const prune = testState.store.pruneTerminalEnvironments.bind(testState.store);
    vi.spyOn(placements, "readRecoveryCandidates").mockImplementation(async () => {
      if (environments.isStopping()) {
        tailEntered.resolve("candidate-read");
        await blockedStore.promise;
      }
      return readCandidates();
    });
    vi.spyOn(testState.store, "pruneTerminalEnvironments").mockImplementation(async (input) => {
      if (environments.isStopping()) {
        tailEntered.resolve("retention-write");
        await blockedStore.promise;
      }
      return prune(input);
    });
    let stopping: Promise<void> | undefined;
    let sweeping: void | Promise<void> = undefined;
    try {
      holdInspection = true;
      sweeping = time.advanceBy(60_000);
      await entered.promise;
      stopping = sidecar.stop();
      expect(await Promise.race([stopping.then(() => "stopped"), tailEntered.promise])).toBe(
        "stopped",
      );
      expect(testState.store.list()).toHaveLength(3);
    } finally {
      blockedStore.resolve();
      remote.resolve({ status: "active" });
      await (stopping ?? sidecar.stop());
      await sweeping;
      await scheduler.stop();
    }
  });

  it("settles an accepted retirement and stops before the next reconciliation candidate", async ({
    signal,
  }) => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const environments = createEnvironments({}, { scheduler });
    const placements = createPlacements();
    runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "absent");
    const sidecar = await startRuntime(createRuntime({ placements, environments, scheduler }));
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
      const stopped = vi.fn();
      stopping = sidecar.stop().then(stopped);
      const pending = formatGatewayPendingCloseSteps();
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
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
    await seedReadyNodeDesktop("worker-close-inspection");
    const inspectionStarted = createDeferredCore();
    const producerSettled = createDeferredCore();
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    let holdInspection = false;
    let inspectionSignal: AbortSignal | undefined;
    const environments = createEnvironments(
      {
        inspect: async ({ signal }) => {
          if (holdInspection) {
            inspectionSignal = signal;
            inspectionStarted.resolve();
            await producerSettled.promise;
          }
          return { status: "active" };
        },
      },
      { scheduler },
    );
    const placements = createPlacements();
    const sidecar = await startRuntime(createRuntime({ placements, environments, scheduler }));
    let stopping: Promise<void> | undefined;
    const stopped = vi.fn();
    try {
      holdInspection = true;
      void time.advanceBy(60_000);
      await inspectionStarted.promise;
      stopping = sidecar.stop().then(stopped);
      expect(inspectionSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      expect(testState.store.get("worker-close-inspection")).toMatchObject({
        state: "ready",
        leaseId: "lease:worker-close-inspection",
      });
      producerSettled.resolve();
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      producerSettled.resolve();
      await (stopping ?? sidecar?.stop());
      await scheduler.stop();
    }
  });

  it("defers workspace cleanup for 50 failed placements until the first background sweep", async () => {
    const placements = createPlacements(true);
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
      await failPlacement(placements, provisioning, "worker admission deadline exceeded");
    }
    const before = await placements.listAsync();
    const environments = createEnvironments();
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const resolveWorkspace = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      return {
        kind: "local" as const,
        path: path.join(testState.root, sessionId),
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
    ["a local turn claim", true],
    ["an active owner epoch", false],
  ] as const)(
    "never reaches worker providers during startup while a failed placement retains %s",
    async (_, claimLocalTurn) => {
      const environmentId = "worker-startup-fenced";
      const provision = vi.fn(async () => ({
        leaseId: "lease-startup-fenced",
        ssh: SSH_ENDPOINT,
      }));
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const destroy = vi.fn(async () => {});
      const environments = createEnvironments({ provision, inspect, destroy });
      await requestProvisioningTeardown(environmentId, "provision:startup-fenced");
      const placements = createPlacements(true);
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
        failed = await failPlacement(placements, requested);
        // Current dispatch binds environments only after its local turn drains; preserve a
        // crash-era terminal environment reference in SQLite without fabricating record shapes.
        testState.stateDb.db
          .prepare("UPDATE worker_session_placements SET environment_id = ? WHERE session_id = ?")
          .run(environmentId, failed.sessionId);
      } else {
        const starting = await seedStartingPlacement(placements, environmentId, "remote-exec");
        failed = await failPlacement(placements, starting);
        // Preserve crash-era ownership; current activation rejects this destroying allocation.
        testState.stateDb.db
          .prepare(
            "UPDATE worker_session_placements SET active_owner_epoch = 1 WHERE session_id = ?",
          )
          .run(failed.sessionId);
      }
      // These crash-era fixtures bypass receipts; reload the durable row explicitly.
      failed = (await placements.getWithMoveAsync(failed.sessionId)).placement;
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
      const sidecar = await startRuntime(
        createRuntime({
          placements,
          environments,
          initialPlacements: await placements.listAsync(),
        }),
      );
      try {
        expect(sidecar).not.toBeNull();
        expect((await preservedSessionKeys()).has(failedSessionKey)).toBe(true);
        await environments.reconcileOnce();
        expect(provision).not.toHaveBeenCalled();
        expect(inspect).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(testState.store.get(environmentId)).toMatchObject({
          state: "provisioning",
          leaseId: null,
          destroyRequestedAtMs: expect.any(Number),
        });
        await testState.store.transition({
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
    const environments = createEnvironments({ provision, resolveAllocation, destroy });
    await requestProvisioningTeardown(environmentId, operationId);
    const placements = createPlacements(true);
    const provisioning = await seedProvisioningPlacement(placements, environmentId, "remote-exec");
    const failed = await failPlacement(placements, provisioning);
    expect(failed).toMatchObject({
      state: "failed",
      environmentId,
      turnClaim: null,
      activeOwnerEpoch: null,
    });
    const runtime = createRuntime({
      placements,
      environments,
      initialPlacements: await placements.listAsync(),
    });
    let registeredSidecar: { stop: () => Promise<void> } | undefined;
    const starting = startRuntime(runtime, {
      registerSidecar: (sidecar) => {
        registeredSidecar = sidecar;
      },
    });

    try {
      const first = await Promise.race([
        starting.then(() => "ready"),
        resolutionStarted.promise.then(() => "resolution"),
      ]);
      expect(first).toBe("ready");
      const sidecar = await starting;
      await resolutionStarted.promise;
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith({ region: "test" }, operationId);
      expect(testState.store.get(environmentId)).toMatchObject({
        state: "provisioning",
        leaseId: null,
        destroyRequestedAtMs: expect.any(Number),
      });

      const stopped = vi.fn();
      const stopping = sidecar.stop().then(stopped);
      await Promise.resolve();
      expect(stopped).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();

      releaseResolution.resolve();
      await stopping;

      expect(provision).not.toHaveBeenCalled();
      expect(testState.prepareInstallation).not.toHaveBeenCalled();
      expect(testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledExactlyOnceWith({
        leaseId: "lease-startup-adopted",
        profile: { region: "test" },
      });
      expect(testState.store.get(environmentId)).toMatchObject({
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
