import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([false, true])(
    "withdraws dedicated access before persistence settles (rejected=%s)",
    async (rejected) => {
      const node = await support.seedReadyNodeDesktop("preview-withdrawal");
      let sharedHost: boolean | undefined = false;
      const service = support.createService(
        support.createProvider({
          resolveAllocation: async () => ({ leaseId: node.leaseId!, sharedHost: false }),
          inspect: async () => ({ status: "active", sharedHost }),
        }),
      );
      await service.reconcileOnce();
      const qualification = service.getDedicatedNodeLeaseSignal(node.environmentId)!;
      expect(qualification.aborted).toBe(false);
      const entered = createDeferred();
      const finish = createDeferred();
      const store = support.testState.store;
      const persist = store.reconcileSharedHost.bind(store);
      vi.spyOn(store, "reconcileSharedHost").mockImplementationOnce(async (input) => {
        entered.resolve();
        await finish.promise;
        if (rejected) {
          throw new Error("fixture persistence failure");
        }
        return persist(input);
      });
      sharedHost = undefined;
      const reconciliation = service.reconcileOnce();
      try {
        await entered.promise;
        expect(qualification.aborted).toBe(true);
        expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBeUndefined();
      } finally {
        finish.resolve();
        await reconciliation;
      }
      expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBeUndefined();
    },
  );

  it("requires fresh explicit dedicated-node inspection for restricted previews without changing legacy classification", async () => {
    const node = await support.seedReadyNodeDesktop("preview-dedicated");
    let sharedHost: boolean | undefined;
    let inspectionFails = false;
    const provider = support.createProvider({
      resolveAllocation: async () => ({ leaseId: node.leaseId!, sharedHost: false }),
      inspect: async () => {
        if (inspectionFails) {
          throw new Error("provider temporarily unavailable");
        }
        return { status: "active", ...(sharedHost === undefined ? {} : { sharedHost }) };
      },
    });
    const service = support.createService(provider);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    await service.reconcileOnce();
    expect(service.get(node.environmentId)?.sharedHost).toBe(false);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    const firstQualification = service.getDedicatedNodeLeaseSignal(node.environmentId)!;
    await service.reconcileOnce();
    expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(firstQualification);
    expect(firstQualification.aborted).toBe(false);
    inspectionFails = true;
    await service.reconcileOnce();
    expect(service.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(firstQualification);
    expect(firstQualification.aborted).toBe(false);
    inspectionFails = false;
    sharedHost = undefined;
    await service.reconcileOnce();
    expect(service.get(node.environmentId)?.sharedHost).toBe(false);
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    expect(firstQualification.aborted).toBe(true);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    sharedHost = true;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    sharedHost = false;
    await service.reconcileOnce();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    await service.stop();
    expect(Boolean(service.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    const restarted = support.createService(provider);
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    await restarted.reconcileOnce();
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(true);
    const epoch = restarted.get(node.environmentId)!.ownerEpoch;
    const restartedQualification = restarted.getDedicatedNodeLeaseSignal(node.environmentId)!;
    await support.testState.store.revokeEnvironmentCredential(node.environmentId);
    expect(restarted.getDedicatedNodeLeaseSignal(node.environmentId)).toBe(restartedQualification);
    expect(restartedQualification.aborted).toBe(false);
    await support.testState.store.revokeEnvironmentCredential(node.environmentId, {
      expectedOwnerEpoch: epoch,
      fenceWorkspaceTransfers: true,
    });
    expect(Boolean(restarted.getDedicatedNodeLeaseSignal(node.environmentId))).toBe(false);
    expect(restartedQualification.aborted).toBe(true);
  });

  it("exposes the catalog display identity without allocating a worker", () => {
    const provider = support.createProvider({ resolveDisplayId: () => "aws" });
    const provision = vi.spyOn(provider, "provision");
    const service = support.createService(provider);
    expect(service.readProviderDisplayId("development")).toBe("aws");
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("warms machine catalogs at startup only for nonterminal environment profiles", async () => {
    const { store } = support.testState;
    const active = await store.createIntent({
      environmentId: "startup-worker",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:startup",
    });
    await store.createIntent({
      environmentId: "terminal-worker",
      providerId: "fake",
      profileId: "terminal",
      profileSnapshot: { settings: { region: "terminal" } },
      provisionOperationId: "provision:terminal",
    });
    await store.transition({ environmentId: "terminal-worker", from: "requested", to: "failed" });
    support.testState.config.cloudWorkers!.profiles!.terminal = {
      provider: "fake",
      settings: { region: "terminal" },
    };
    const listMachineOptions = vi.fn(async () => [
      { id: "medium", label: "Medium", cpu: 4, memoryGb: 16, default: true },
    ]);
    const listOperatingSystems = vi.fn(async () => [
      { id: "linux", label: "Linux", default: true },
    ]);
    const service = support.createService(
      support.createProvider({ listMachineOptions, listOperatingSystems }),
    );
    service.installReconcileEnvironmentGuard(async () => {});
    expect(service.readMachineShape(active.environmentId)).toBeUndefined();
    service.start();
    await support.waitForFast(() =>
      expect(service.readMachineShape(active.environmentId)).toEqual({
        class: "medium",
        os: "linux",
        osLabel: "Linux",
        cpu: 4,
        memoryGb: 16,
      }),
    );
    expect(listMachineOptions).toHaveBeenCalledExactlyOnceWith({ region: "test" });
    expect(listOperatingSystems).toHaveBeenCalledExactlyOnceWith({ region: "test" });
    expect(store.get(active.environmentId)?.profileSnapshot).toEqual(active.profileSnapshot);
  });

  it("maintains configured providers on schedule without environments and stops after shutdown", async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const maintain = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider(), {
      maintainProviders: maintain,
      scheduler,
    });

    expect(support.testState.store.list()).toEqual([]);
    workerService.start();
    await workerService.reconcileOnce();
    expect(maintain).toHaveBeenCalledOnce();
    await time.advanceBy(250);
    expect(maintain).toHaveBeenCalledTimes(2);
    await workerService.stop();
    await time.advanceBy(25);
    expect(maintain).toHaveBeenCalledTimes(2);
  });

  it("keeps maintenance off reconciliation and allocation while shutdown aborts and drains it", async () => {
    const { promise: pending, resolve: finish } = createDeferred();
    const maintainProviders = vi.fn(async (_signal: AbortSignal) => pending);
    const workerService = support.createService(support.createProvider(), { maintainProviders });
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await workerService.reconcileOnce();
      await workerService.reconcileOnce();
      expect(maintainProviders).toHaveBeenCalledOnce();
      await expect(
        workerService.createWithRequest({
          profileId: "development",
          idempotencyKey: "during-maintenance",
        }),
      ).resolves.toMatchObject({ state: "ready" });
      stopping = workerService.stop().then(() => {
        stopped = true;
      });
      expect(maintainProviders.mock.calls[0]![0].aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finish();
      await stopping;
    }
    expect(stopped).toBe(true);
    await workerService.reconcileOnce();
    expect(maintainProviders).toHaveBeenCalledOnce();
  });

  it("reports failed maintenance and retries on the next sweep", async () => {
    const warn = vi.fn();
    const maintainProviders = vi.fn(async () => {
      throw new Error("fixture maintenance failure");
    });
    const workerService = support.createService(support.createProvider(), {
      maintainProviders,
      logger: { warn },
    });
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(maintainProviders).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith(
      "Worker provider maintenance sweep failed; cleanup will retry",
    );
  });

  it("reconciles unrelated leases concurrently", async () => {
    await support.seedReady("worker-concurrent-a");
    await support.seedReady("worker-concurrent-b");
    const { promise: blocked, resolve: release } = createDeferred();
    const inspected: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        await blocked;
        return { status: "active" };
      },
    });

    const reconciliation = support.createService(provider).reconcileOnce();
    try {
      await support.waitForFast(() => expect(inspected).toHaveLength(2));
    } finally {
      release?.();
    }
    await reconciliation;

    expect(new Set(inspected.map(({ leaseId }) => leaseId))).toEqual(
      new Set(["lease:worker-concurrent-a", "lease:worker-concurrent-b"]),
    );
  });

  it("coalesces targeted and full inspection while retaining full-sweep maintenance", async () => {
    const targetId = "worker-targeted-overlap";
    const siblingId = "worker-full-sweep-sibling";
    await support.seedReady(targetId);
    await support.seedReady(siblingId);
    const targetStarted = createDeferred();
    const siblingStarted = createDeferred();
    const finishTarget = createDeferred();
    const inspect = vi.fn(async ({ leaseId }: WorkerLifecycleLease) => {
      if (leaseId === `lease:${targetId}`) {
        targetStarted.resolve();
        await finishTarget.promise;
      } else {
        siblingStarted.resolve();
      }
      return { status: "active" as const };
    });
    const maintainProviders = vi.fn(async () => {});
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");
    const workerService = support.createService(support.createProvider({ inspect }), {
      maintainProviders,
    });
    const uninstall = workerService.installReconcileEnvironmentGuard(async (_id, core) => {
      await core();
    });
    const targeted = workerService.reconcileOnce(targetId);
    let direct: Promise<void> | undefined;
    let full: Promise<void> | undefined;
    try {
      await targetStarted.promise;
      expect(inspect.mock.calls.map(([lease]) => lease.leaseId)).toEqual([`lease:${targetId}`]);
      expect(maintainProviders).not.toHaveBeenCalled();
      expect(prune).not.toHaveBeenCalled();
      direct = workerService.reconcileEnvironment(targetId);
      full = workerService.reconcileOnce();
      await siblingStarted.promise;
      expect(inspect).toHaveBeenCalledTimes(2);
    } finally {
      finishTarget.resolve();
      await Promise.all([targeted, direct, full]);
      await uninstall();
    }
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(maintainProviders).toHaveBeenCalledOnce();
    expect(prune).toHaveBeenCalledOnce();
  });

  it.each(["SQLITE_BUSY", "SQLITE_LOCKED"])(
    "continues reconciliation when terminal cleanup fails with %s",
    async (code) => {
      const prune = vi
        .spyOn(support.testState.store, "pruneTerminalEnvironments")
        .mockImplementation(() => {
          throw Object.assign(new Error("database is locked"), { code });
        });

      await expect(
        support.createService(support.createProvider()).reconcileOnce(),
      ).resolves.toBeUndefined();
      expect(prune).toHaveBeenCalledOnce();
    },
  );

  it("propagates non-lock terminal cleanup failures", async () => {
    const error = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    const prune = vi
      .spyOn(support.testState.store, "pruneTerminalEnvironments")
      .mockImplementation(() => {
        throw error;
      });

    await expect(support.createService(support.createProvider()).reconcileOnce()).rejects.toBe(
      error,
    );
    expect(prune).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "settles provisioning before reporting a timeout (committed=%s)",
    async (committed) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const transitionEntered = createDeferred();
      const releaseTransition = createDeferred();
      const store = support.testState.store;
      const transition = store.transition.bind(store);
      vi.spyOn(store, "transition").mockImplementation(async (input) => {
        if (input.from !== "requested" || input.to !== "provisioning") {
          return transition(input);
        }
        if (committed) {
          const record = await transition(input);
          transitionEntered.resolve();
          await releaseTransition.promise;
          return record;
        }
        transitionEntered.resolve();
        await releaseTransition.promise;
        return transition(input);
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }), {
        providerCallTimeoutMs: 5,
      });
      const creationResult = workerService
        .createWithRequest({
          profileId: "development",
          idempotencyKey: "request-provision-transition-timeout",
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        await Promise.race([
          transitionEntered.promise,
          creationResult.then((result) => {
            throw new Error("Creation ended before provisioning transition", { cause: result });
          }),
        ]);
        await vi.advanceTimersByTimeAsync(5);
      } finally {
        releaseTransition.resolve();
        await creationResult;
      }

      expect(await creationResult).toMatchObject({
        ok: false,
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      expect(provision).not.toHaveBeenCalled();
      expect(store.list()[0]).toMatchObject({
        state: committed ? "provisioning" : "failed",
        lastError: "Worker provider operation timed out after 5ms",
      });
    },
  );

  it("waits for timed-out provider work during shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const provisionStarted = createDeferred();
    const tunnelsStopped = createDeferred();
    const { promise: provisionPending, resolve: finishProvision } = createDeferred();
    const provision = vi.fn(async () => {
      provisionStarted.resolve();
      await provisionPending;
      return { leaseId: "lease-stop-timeout", ssh: support.SSH_ENDPOINT };
    });
    const stopAll = vi.fn(async () => {
      tunnelsStopped.resolve();
    });
    const tunnelManager = {
      stopAll,
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider({ provision }), {
      providerCallTimeoutMs: 5,
      tunnelManager,
    });
    const creationResult = workerService
      .createWithRequest({
        profileId: "development",
        idempotencyKey: "request-stop-provider-timeout",
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let stopped = false;
    let stopping: Promise<void> | undefined;

    try {
      await Promise.race([
        provisionStarted.promise,
        creationResult.then((result) => {
          throw new Error("Creation ended before provider entry", { cause: result });
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5);
      expect(await creationResult).toMatchObject({
        ok: false,
        error: { code: "provider_failure" } satisfies Partial<WorkerEnvironmentServiceError>,
      });
      stopping = workerService.stop().then(() => {
        stopped = true;
      });
      await tunnelsStopped.promise;
      expect(stopAll).toHaveBeenCalledOnce();
      expect(stopped).toBe(false);
    } finally {
      finishProvision();
      await creationResult;
      await stopping;
    }

    expect(stopped).toBe(true);
  });

  it("reconciles periodically through the placement guard and retires the schedule on stop", async () => {
    const environmentId = "worker-guarded-reconcile";
    await support.seedReady(environmentId);
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const liveEvents = support.createLiveEvents();
    const unsubscribeTurnClaimClosed = vi.fn();
    const placementStore = {
      assertWorkerRuntimeRefresh: vi.fn(() => {
        throw new Error("Runtime refresh is outside this timer fixture");
      }),
      readWorkerTurnClaim: vi.fn(),
      readWorkerTurnLiveAckCursor: vi.fn(() => 0),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(),
      prepareWorkspaceResultOwnerRevocation: vi.fn(),
      registerTurnClaimClosedHandler: vi.fn(() => unsubscribeTurnClaimClosed),
    };
    const workerService = support.createService(support.createProvider({ inspect }), {
      liveEvents,
      placementStore,
      scheduler,
    });
    const guardedEnvironmentIds: string[] = [];
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (guardedEnvironmentId, reconcileCore) => {
        guardedEnvironmentIds.push(guardedEnvironmentId);
        await reconcileCore();
      },
    );

    expect(placementStore.registerTurnClaimClosedHandler).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    workerService.start();
    workerService.start();
    await workerService.reconcileOnce();
    await time.advanceBy(25);
    expect(guardedEnvironmentIds).toEqual([environmentId, environmentId, environmentId]);
    expect(inspect).toHaveBeenCalledTimes(3);
    await uninstallGuard();
    await workerService.reconcileEnvironment(environmentId);
    expect(guardedEnvironmentIds).toHaveLength(3);
    expect(inspect).toHaveBeenCalledTimes(4);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(unsubscribeTurnClaimClosed).toHaveBeenCalledOnce();
    await time.advanceBy(25);
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("closes new guarded reconciliation and drains the admitted operation on uninstall", async () => {
    const environmentId = "worker-guard-uninstall";
    await support.seedReady(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const workerService = support.createService(support.createProvider({ inspect }));
    const { promise: guardPending, resolve: releaseGuard } = createDeferred();
    const { promise: guardStarted, resolve: signalGuardStarted } = createDeferred();
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (_guardedEnvironmentId, reconcileCore) => {
        signalGuardStarted?.();
        await guardPending;
        await reconcileCore();
      },
    );
    const reconciliation = workerService.reconcileEnvironment(environmentId);
    await guardStarted;
    let uninstalled = false;
    const uninstalling = uninstallGuard().then(() => {
      uninstalled = true;
    });
    await workerService.reconcileEnvironment(environmentId);
    await Promise.resolve();
    expect(uninstalled).toBe(false);
    expect(inspect).not.toHaveBeenCalled();

    releaseGuard?.();
    await Promise.all([reconciliation, uninstalling]);
    expect(inspect).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each(["reconcileEnvironment", "reconcileOnce"] as const)(
    "closes guarded reconciliation admission and drains admitted %s recovery during stop",
    async (method) => {
      const environmentId = "worker-guard-stop";
      await support.seedReady(environmentId);
      const inspect = vi.fn(async () => ({ status: "active" as const }));
      const workerService = support.createService(support.createProvider({ inspect }));
      const { promise: guardPending, resolve: releaseGuard } = createDeferred();
      const { promise: guardStarted, resolve: signalGuardStarted } = createDeferred();
      let guardCompleted = false;
      const uninstallGuard = workerService.installReconcileEnvironmentGuard(
        async (_guardedEnvironmentId, reconcileCore) => {
          signalGuardStarted?.();
          await guardPending;
          await reconcileCore();
          guardCompleted = true;
        },
      );
      const admitted = workerService[method](environmentId);
      await guardStarted;

      let stopped = false;
      const stopping = workerService.stop().then(() => {
        stopped = true;
      });
      await workerService[method](environmentId);
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(guardCompleted).toBe(false);
      expect(inspect).not.toHaveBeenCalled();

      releaseGuard?.();
      await Promise.all([admitted, stopping]);
      await uninstallGuard();
      expect(guardCompleted).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
    },
  );

  it("rejects a create queued before service shutdown once its lock is acquired", async () => {
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const provision = vi.fn(support.createProvider().provision);
    const workerService = support.createService(support.createProvider({ provision }));
    const first = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-queued-before-stop",
    });
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const queued = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-queued-before-stop",
    });
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(first).resolves.toMatchObject({ state: "ready" });
    await queuedResult;
    await stopping;
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("drains a destroy accepted before service shutdown while it waits for the lock", async () => {
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-destroy-before-stop",
    });
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const environmentId = support.testState.store.list()[0]?.environmentId;
    expect(environmentId).toBeTruthy();
    const teardown = workerService.destroy(environmentId!);
    const teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await teardownResult;
    await stopping;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("drains accepted operations after reconciliation rejects during shutdown", async () => {
    const durableStore = support.testState.store;
    support.testState.store = {
      ...support.testState.store,
      listForReconcile() {
        throw new Error("reconcile database read failed");
      },
    };
    const { promise: bootstrapPending, resolve: finishBootstrap } = createDeferred();
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const workerService = support.createService(support.createProvider());
    const creation = workerService.createWithRequest({
      profileId: "development",
      idempotencyKey: "request-stop-after-reconcile-failure",
    });
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const reconciliation = workerService.reconcileOnce();
    const reconciliationResult = expect(reconciliation).rejects.toThrow(
      "reconcile database read failed",
    );
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });

    await reconciliationResult;
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await stopping;
    expect(stopped).toBe(true);
    expect(durableStore.list()).toHaveLength(1);
  });

  it("starts without blocking gateway startup and drains reconciliation on stop", async () => {
    await support.seedReady("worker-slow-inspection");
    const { promise: inspectionPending, resolve: finishInspection } = createDeferred();
    const inspect = vi.fn(async () => {
      await inspectionPending;
      return { status: "active" as const };
    });
    const workerService = support.createService(support.createProvider({ inspect }));

    workerService.start();
    await support.waitForFast(() => expect(inspect).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishInspection?.();
    await stopping;
    expect(stopped).toBe(true);
    await expect(
      workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "request-after-stop",
      }),
    ).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(workerService.destroy("worker-slow-inspection")).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
  });
});
