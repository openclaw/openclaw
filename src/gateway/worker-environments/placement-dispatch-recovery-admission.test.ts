import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import * as spawnDiagnostics from "../../process/spawn-diagnostics.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import {
  cleanupWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

function createStore() {
  return createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => 1_000,
  });
}

function coordinate(harness: ReturnType<typeof createHarness>) {
  return coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run());
}

function prepareTargetedAdmissionObserver(placements: ReturnType<typeof createStore>) {
  // The harness copies store methods. Install the spy before construction, then
  // arm it only when the test reaches its recovery observation boundary.
  const read = placements.readProjection.bind(placements);
  const reads = vi.spyOn(placements, "readProjection");
  return (harness: ReturnType<typeof createHarness>) => {
    const unitReached = createDeferredCore();
    const reconcile = harness.service.reconcileActive;
    vi.spyOn(harness.service, "reconcileActive").mockImplementation((environmentId, admit) =>
      reconcile(environmentId, (sessionIds, run) => {
        if (!admit) {
          throw new Error("Recovery requires coordinator admission");
        }
        const operation = admit(sessionIds, run);
        unitReached.resolve();
        return operation;
      }),
    );
    reads.mockClear();
    reads.mockImplementation((...args) => {
      unitReached.resolve();
      return read(...args);
    });
    return { unitReached: unitReached.promise, reads };
  };
}

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 10_000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("placement recovery session admission with persisted placements", () => {
  support.setupWorkerEnvironmentServiceSuite({ reuseReadWorkers: true });
  let releaseOwnedWork: (() => Promise<void>) | undefined;
  afterEach(async () => {
    // Release blocked provider work before the service fixture drains on a failed test.
    await releaseOwnedWork?.();
    releaseOwnedWork = undefined;
  });

  it.each(["busy", "idle"] as const)(
    "startup pre-pass leaves %s Stop with its current final-save owner",
    async (state) => {
      const placements = createStore();
      const claimStop = vi.spyOn(placements, "claimReclaimWorkspaceResult");
      const reads = vi.spyOn(placements, "readProjection");
      const stopEntered = createDeferredCore();
      const releaseStop = createDeferredCore();
      const environmentEntered = createDeferredCore();
      const releaseEnvironment = createDeferredCore();
      const harness = createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
        runReclaimPreparation: async ({ run, authorize }) => {
          stopEntered.resolve();
          await releaseStop.promise;
          return run(authorize);
        },
      });
      const active = await harness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("Stop fixture was not active");
      }
      harness.markEnvironmentOwnerEpoch(2);
      placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      const coordinated = coordinate(harness);
      vi.mocked(harness.environments.reconcileEnvironment).mockImplementation(async () => {
        environmentEntered.resolve();
        await releaseEnvironment.promise;
      });
      const stop = state === "busy" ? coordinated.reclaim(REQUEST) : undefined;
      void stop?.catch(stopEntered.reject);
      let sweep: Promise<void> | undefined;
      try {
        if (stop) {
          await stopEntered.promise;
        }
        reads.mockClear();
        sweep = coordinated.reconcile("startup");
        void sweep.catch(environmentEntered.reject);
        await environmentEntered.promise;
        expect(claimStop).toHaveBeenCalledTimes(state === "busy" ? 0 : 1);
        if (state === "busy") {
          expect(reads).not.toHaveBeenCalled();
          expect(placements.listPendingWorkspaceResults()).toEqual([]);
        } else {
          expect(placements.listPendingWorkspaceResults()).toMatchObject([
            { sessionId: REQUEST.sessionId, recoveryRequestedAtMs: 1_000 },
          ]);
        }
        releaseEnvironment.resolve();
        await sweep;
      } finally {
        releaseEnvironment.resolve();
        releaseStop.resolve();
        await Promise.allSettled([sweep, stop]);
      }
      expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["startup", "full"] as const)(
    "%s recovery skips a dispatch registered after its candidate listing",
    async (mode) => {
      const placements = createStore();
      const requested = await placements.startDispatch(REQUEST);
      placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "previous attempt",
      });
      const readCandidates = placements.readRecoveryCandidates.bind(placements);
      const candidateReads = vi.spyOn(placements, "readRecoveryCandidates");
      const harness = createHarness(support.testState.stateDb, placements, {
        environmentGeneration: 3,
      });
      const coordinated = coordinate(harness);
      const tunnelEntered = createDeferredCore();
      const releaseTunnel = createDeferredCore();
      const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
      vi.mocked(harness.environments.startTunnel).mockImplementation(async (...args) => {
        tunnelEntered.resolve();
        await releaseTunnel.promise;
        return startTunnel(...args);
      });
      let listings = 0;
      let dispatch: ReturnType<typeof coordinated.dispatch> | undefined;
      candidateReads.mockImplementation(async () => {
        const candidates = await readCandidates();
        if (++listings === (mode === "startup" ? 2 : 1)) {
          dispatch = coordinated.dispatch(REQUEST);
          void dispatch.catch(tunnelEntered.reject);
          await tunnelEntered.promise;
        }
        return candidates;
      });
      try {
        await coordinated.reconcile(mode === "startup" ? "startup" : undefined);
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "syncing",
          recoveryError: null,
        });
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      } finally {
        releaseTunnel.resolve();
        await dispatch?.catch(() => undefined);
      }
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    },
  );

  it("targeted recovery reads a dispatch only after its activation settles", async () => {
    const placements = createStore();
    const observe = prepareTargetedAdmissionObserver(placements);
    const harness = createHarness(support.testState.stateDb, placements);
    const tunnelEntered = createDeferredCore();
    const releaseTunnel = createDeferredCore();
    const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
    vi.mocked(harness.environments.startTunnel).mockImplementation(async (...args) => {
      tunnelEntered.resolve();
      await releaseTunnel.promise;
      return startTunnel(...args);
    });
    const coordinated = coordinate(harness);
    const dispatch = coordinated.dispatch({ ...REQUEST, executionMode: "remote-exec" });
    void dispatch.catch(tunnelEntered.reject);
    await tunnelEntered.promise;
    const observation = observe(harness);
    const sweep = coordinated.reconcileActive(harness.ready.environmentId);
    try {
      await observation.unitReached;
      expect(observation.reads).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("syncing");
    } finally {
      releaseTunnel.resolve();
      await dispatch;
      await sweep;
    }
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it.each(["full", "targeted"] as const)(
    "%s recovery does not expire a live Move while destination admission still sees local placement",
    async (mode) => {
      const placements = createStore();
      const observe = prepareTargetedAdmissionObserver(placements);
      const harness = createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
      });
      const active = await harness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("Move fixture was not active");
      }
      harness.markEnvironmentOwnerEpoch(2);
      const coordinated = coordinate(harness);
      const localEntered = createDeferredCore();
      const releaseDestination = createDeferredCore();
      vi.spyOn(placements, "startDispatch").mockImplementation(async () => {
        localEntered.resolve();
        await releaseDestination.promise;
        throw new Error("fixture destination unavailable");
      });
      const move = coordinated.move({
        ...REQUEST,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "profile", profileId: "next" },
      });
      void move.catch(localEntered.reject);
      let sweep: Promise<void> | undefined;
      try {
        await localEntered.promise;
        const intent = placements.getPlacementMove(REQUEST.sessionId);
        expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
        const observation = observe(harness);
        sweep = coordinated.reconcileActive(mode === "targeted" ? active.environmentId : undefined);
        if (mode === "targeted") {
          await observation.unitReached;
          expect(observation.reads).not.toHaveBeenCalled();
        } else {
          await sweep;
        }
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "local",
          recoveryError: null,
        });
        expect(placements.getPlacementMove(REQUEST.sessionId)).toEqual(intent);
      } finally {
        releaseDestination.resolve();
        await expect(move).rejects.toThrow("fixture destination unavailable");
        await sweep;
      }
    },
  );

  it("lent result recovery leaves the admitted Move intent for its owner and later recovery", async () => {
    const placements = createStore();
    const claimWaitEntered = createDeferredCore();
    const releaseClaimWait = createDeferredCore();
    const interruption = new Error("fixture Move interrupted after claim wait");
    const harness = createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
      runMoveBarrier: async ({ sessionId, begin }) => {
        await begin();
        await coordinated.awaitTurnClaimRelease(sessionId, () => {
          claimWaitEntered.resolve();
          return releaseClaimWait.promise;
        });
        throw interruption;
      },
    });
    const active = await harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("Move fixture was not active");
    }
    harness.markEnvironmentOwnerEpoch(2);
    const claim = await placements.claimTurn({
      ...REQUEST,
      claimId: "move-wait-claim",
      runId: "move-wait-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const coordinated = coordinate(harness);
    const move = coordinated.move({
      ...REQUEST,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    void move.catch(claimWaitEntered.reject);
    let recovery: Promise<void> | undefined;
    try {
      await claimWaitEntered.promise;
      const intent = placements.getPlacementMove(REQUEST.sessionId);
      expect(intent).toBeDefined();
      recovery = coordinated.reconcileActive(active.environmentId);
      await recovery;
      expect(placements.getPlacementMove(REQUEST.sessionId)).toEqual(intent);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: { claimId: claim.claimId },
      });
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    } finally {
      try {
        await placements.releaseTurn(claim);
      } finally {
        releaseClaimWait.resolve();
        await Promise.allSettled([move, recovery]);
      }
    }
    await expect(move).rejects.toBe(interruption);
    expect(placements.getPlacementMove(REQUEST.sessionId)).toBeDefined();
    await coordinated.reconcileActive(active.environmentId);
    expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
    expect(placements.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("reads pending results after a same-session Stop has settled", async () => {
    const placements = createStore();
    const observe = prepareTargetedAdmissionObserver(placements);
    const abandon = vi.spyOn(placements, "abandonWorkspaceResult");
    const reconciliationEntered = createDeferredCore();
    const releaseReconciliation = createDeferredCore();
    const harness = createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
      afterReconcile: async () => {
        reconciliationEntered.resolve();
        await releaseReconciliation.promise;
      },
    });
    const active = await harness.placements.seedActive(2);
    harness.markEnvironmentOwnerEpoch(2);
    const coordinated = coordinate(harness);
    const stop = coordinated.reclaim(REQUEST);
    void stop.catch(reconciliationEntered.reject);
    await reconciliationEntered.promise;
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
    const observation = observe(harness);
    abandon.mockClear();
    const sweep = coordinated.reconcileActive(active.environmentId!);
    try {
      await observation.unitReached;
      expect(observation.reads).not.toHaveBeenCalled();
    } finally {
      releaseReconciliation.resolve();
      await stop;
      await sweep;
    }
    expect(placements.listPendingWorkspaceResults()).toEqual([]);
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(abandon).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("spreads startup orphan inventories across idle sweeps and eventually reclaims every checkout", async () => {
    const template = path.join(support.testState.root, "template");
    await fs.mkdir(template);
    await git(template, "init", "--quiet", "--template=");
    const tree = await git(template, "write-tree");
    const placements = createStore();
    const roots = Array.from({ length: 64 }, (_, index) =>
      path.join(support.testState.root, `checkout-${String(index).padStart(2, "0")}`),
    );
    const rootsBySession = new Map<string, string>();
    for (const [index, root] of roots.entries()) {
      await fs.cp(template, root, { recursive: true });
      const sessionId = `orphan-scan-${String(index).padStart(2, "0")}`;
      rootsBySession.set(sessionId, root);
      const placement = await placements.startDispatch({
        ...REQUEST,
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
      });
      placements.fail({
        sessionId,
        expectedGeneration: placement.generation,
        recoveryError: "finished fixture",
      });
    }
    const orphanRoot = roots.at(-1)!;
    const cleanupRef = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef("orphan-claim"));
    await git(orphanRoot, "update-ref", cleanupRef, tree);
    const harness = createHarness(support.testState.stateDb, placements, {
      resolveWorkspace: async ({ sessionId }) => {
        const root = rootsBySession.get(sessionId);
        if (!root) {
          throw new Error(`Unknown fixture session: ${sessionId}`);
        }
        return { kind: "local", path: root };
      },
    });
    const coordinated = coordinate(harness);
    using spawns = vi.spyOn(spawnDiagnostics, "recordChildProcessSpawn");
    const gitSpawns = () =>
      spawns.mock.calls.filter(
        ([command]) => path.basename(command).replace(/\.exe$/, "") === "git",
      );
    const inventoryRoots = () =>
      gitSpawns().flatMap(([, child]) => {
        const args = child.spawnargs;
        return args.includes("for-each-ref") ? [args[args.indexOf("-C") + 1]!] : [];
      });

    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
    spawnDiagnostics.emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    const byOperation = new Map<string, number>();
    const stopDiagnostics = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn" && event.family === "git") {
        const operation = event.operation ?? "unknown";
        byOperation.set(operation, (byOperation.get(operation) ?? 0) + event.count);
      }
    });
    const startedAt = performance.now();
    const measurement = (phase: string) => ({
      phase,
      checkouts: roots.length,
      totalSpawns: gitSpawns().length,
      inventoryCount: inventoryRoots().length,
      elapsedMs: Math.round(performance.now() - startedAt),
      rssBytes: process.memoryUsage().rss,
    });
    try {
      await coordinated.reconcile("startup");
      expect(gitSpawns()).toHaveLength(0);
      for (let sweep = 0; sweep < 3; sweep++) {
        await coordinated.reconcileActive();
      }
      console.info(JSON.stringify(measurement("first-three-sweeps")));
      expect(inventoryRoots().length).toBeGreaterThan(0);
      expect(inventoryRoots().length).toBeLessThanOrEqual(24);

      const foreground = tryBeginGatewayIndependentRootWorkAdmission("test:foreground-request");
      if (!foreground) {
        throw new Error("Foreground fixture could not acquire Gateway admission");
      }
      const beforeBusySweep = gitSpawns().length;
      try {
        await coordinated.reconcileActive();
        expect(gitSpawns()).toHaveLength(beforeBusySweep);
      } finally {
        foreground.release();
      }

      for (let sweep = 0; sweep < 8; sweep++) {
        await coordinated.reconcileActive();
      }
      const completed = measurement("complete");
      {
        const sampleAt = performance.now() + 60_000;
        using sampleClock = vi.spyOn(performance, "now");
        sampleClock.mockReturnValue(sampleAt);
        spawnDiagnostics.emitChildProcessSpawnSample();
      }
      console.info(JSON.stringify({ ...completed, byOperation: Object.fromEntries(byOperation) }));
      expect(inventoryRoots().toSorted()).toEqual(roots.toSorted());
      // One inventory per checkout plus the orphan's ref-queue lookup and deletion.
      expect(gitSpawns()).toHaveLength(66);
      expect(Object.fromEntries(byOperation)).toEqual({ "workspace.result-cleanup": 66 });
      expect(await git(orphanRoot, "for-each-ref", "--format=%(refname)", cleanupRef)).toBe("");
    } finally {
      stopDiagnostics();
      setDiagnosticsEnabledForProcess(false);
      spawnDiagnostics.emitChildProcessSpawnSample();
      resetDiagnosticEventsForTest();
    }
  });

  it("retries orphan cleanup on the next full sweep when a sharing session was busy", async () => {
    const root = support.testState.root;
    await git(root, "init", "--quiet");
    await fs.writeFile(path.join(root, "result.txt"), "retired workspace result");
    await git(root, "add", "result.txt");
    const tree = await git(root, "write-tree");
    const cleanupRef = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef("orphan-claim"));
    await git(root, "update-ref", cleanupRef, tree);
    const placements = createStore();
    const idle = await placements.startDispatch({
      ...REQUEST,
      sessionId: "idle",
      sessionKey: "agent:main:idle",
    });
    placements.fail({
      sessionId: idle.sessionId,
      expectedGeneration: idle.generation,
      recoveryError: "finished fixture",
    });
    const harness = createHarness(support.testState.stateDb, placements, { workspacePath: root });
    const coordinated = coordinate(harness);
    await coordinated.reconcile("startup");
    const providerEntered = createDeferredCore();
    const releaseProvider = createDeferredCore();
    const create = vi.mocked(harness.environments.createWithRequest).getMockImplementation()!;
    vi.mocked(harness.environments.createWithRequest).mockImplementation(async (...args) => {
      providerEntered.resolve();
      await releaseProvider.promise;
      return create(...args);
    });
    const dispatch = coordinated.dispatch(REQUEST);
    void dispatch.catch(providerEntered.reject);
    try {
      await providerEntered.promise;
      await coordinated.reconcileActive();
      expect(await git(root, "for-each-ref", "--format=%(refname)", cleanupRef)).toBe(cleanupRef);
    } finally {
      releaseProvider.resolve();
      await dispatch;
    }
    await coordinated.reconcileActive();
    expect(await git(root, "for-each-ref", "--format=%(refname)", cleanupRef)).toBe("");
  });

  it("a real dispatch reaches device provisioning while another placement's teardown is stuck", async () => {
    const placements = createStore();
    const harness = createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
    });
    const requested = await placements.startDispatch({
      ...REQUEST,
      sessionId: "cloud",
      sessionKey: "agent:main:cloud",
    });
    const provisioning = placements.transition({
      sessionId: "cloud",
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "cloud-environment" },
    });
    placements.fail({
      sessionId: "cloud",
      expectedGeneration: provisioning.generation,
      recoveryError: "provider teardown required",
    });
    const destroyEntered = createDeferredCore();
    const releaseDestroy = createDeferredCore();
    const providerEntered = createDeferredCore();
    await support.seedReady("cloud-environment");
    const cloudEnvironments = support.createService(
      support.createProvider({
        destroy: async () => {
          destroyEntered.resolve();
          await releaseDestroy.promise;
        },
      }),
    );
    const originalGet = vi.mocked(harness.environments.get).getMockImplementation()!;
    vi.mocked(harness.environments.get).mockImplementation((environmentId) =>
      environmentId === "cloud-environment"
        ? cloudEnvironments.get(environmentId)
        : originalGet(environmentId),
    );
    vi.mocked(harness.environments.destroy).mockImplementation(cloudEnvironments.destroy);
    const create = vi.mocked(harness.environments.createWithRequest).getMockImplementation()!;
    vi.mocked(harness.environments.createWithRequest).mockImplementation(async (...args) => {
      providerEntered.resolve();
      return create(...args);
    });
    const coordinated = coordinate(harness);
    const sweep = coordinated.reconcileActive();
    void sweep.catch(destroyEntered.reject);
    const dispatch = destroyEntered.promise.then(() => {
      bindDeviceWorkerAvailability(harness.environments, async () => ({
        available: true,
        node: {
          nodeId: "paired-local-device",
          connId: "device-connection",
          pairingIdentity: "device-pairing",
          pairingGeneration: "device-generation",
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
          protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          workerHost: {
            enabled: true,
            capacity: { total: 1, available: 1 },
            capturedExecPolicy: true,
          },
          commands: [],
        },
      }));
      return coordinated.dispatch({
        ...REQUEST,
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
        deviceId: "paired-local-device",
        profileId: "device:paired-local-device",
      });
    });
    releaseOwnedWork = async () => {
      releaseDestroy.resolve();
      await Promise.allSettled([sweep, dispatch]);
    };
    void dispatch.catch(providerEntered.reject);
    try {
      await providerEntered.promise;
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    } finally {
      releaseDestroy.resolve();
      await sweep;
      await dispatch;
    }
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
  });
});
