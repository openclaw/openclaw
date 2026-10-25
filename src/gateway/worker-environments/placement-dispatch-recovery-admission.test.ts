import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import * as spawnDiagnostics from "../../process/spawn-diagnostics.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  placementClaim,
  placementSource,
  placementTransition,
} from "./placement-suite.test-support.js";
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

function coordinate(harness: Awaited<ReturnType<typeof createHarness>>) {
  return coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run());
}

function barrier() {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  return {
    entered: entered.promise,
    reject: entered.reject,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

async function seedActive(harness: Awaited<ReturnType<typeof createHarness>>) {
  const active = await harness.placements.seedActive(2);
  if (active.state !== "active") {
    throw new Error("Fixture was not active");
  }
  harness.markEnvironmentOwnerEpoch(2);
  return active;
}

async function seedFailed(
  placements: ReturnType<typeof createStore>,
  sessionId = REQUEST.sessionId,
) {
  const placement = await placements.startDispatch({
    ...REQUEST,
    sessionId,
    sessionKey: sessionId === REQUEST.sessionId ? REQUEST.sessionKey : `agent:main:${sessionId}`,
  });
  await placements.fail({
    sessionId,
    expectedGeneration: placement.generation,
    recoveryError: "finished fixture",
  });
  return placement;
}

const cleanupRef = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef("orphan-claim"));
const readCleanupRef = (root: string) =>
  git(root, "for-each-ref", "--format=%(refname)", cleanupRef);

function prepareTargetedAdmissionObserver(placements: ReturnType<typeof createStore>) {
  // The harness copies store methods. Install the spy before construction, then
  // arm it only when the test reaches its recovery observation boundary.
  const read = placements.readProjection.bind(placements);
  const reads = vi.spyOn(placements, "readProjection");
  return (harness: Awaited<ReturnType<typeof createHarness>>) => {
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
  support.setupWorkerEnvironmentServiceSuite();
  let placements: ReturnType<typeof createStore>;
  beforeEach(() => {
    placements = createStore();
  });
  let releaseOwnedWork: (() => Promise<void>) | undefined;
  afterEach(async () => {
    // Release blocked provider work before the service fixture drains on a failed test.
    await releaseOwnedWork?.();
    releaseOwnedWork = undefined;
  });

  it.each(["busy", "idle"] as const)(
    "startup pre-pass leaves %s Stop with its current final-save owner",
    async (state) => {
      const claimStop = vi.spyOn(placements, "claimReclaimWorkspaceResult");
      const reads = vi.spyOn(placements, "readProjection");
      const stopBarrier = barrier();
      const environmentBarrier = barrier();
      const harness = await createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
        runReclaimPreparation: async ({ run, authorize }) => {
          await stopBarrier.wait();
          return run(authorize);
        },
      });
      const active = await seedActive(harness);
      await placements.startDrain(placementTransition(active));
      const coordinated = coordinate(harness);
      vi.mocked(harness.environments.reconcileEnvironment).mockImplementation(
        environmentBarrier.wait,
      );
      const stop = state === "busy" ? coordinated.reclaim(REQUEST) : undefined;
      void stop?.catch(stopBarrier.reject);
      let sweep: Promise<void> | undefined;
      try {
        if (stop) {
          await stopBarrier.entered;
        }
        reads.mockClear();
        sweep = coordinated.reconcile("startup");
        void sweep.catch(environmentBarrier.reject);
        await environmentBarrier.entered;
        expect(claimStop).toHaveBeenCalledTimes(state === "busy" ? 0 : 1);
        if (state === "busy") {
          expect(reads).not.toHaveBeenCalled();
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        } else {
          expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
            { sessionId: REQUEST.sessionId, recoveryRequestedAtMs: 1_000 },
          ]);
        }
        environmentBarrier.release();
        await sweep;
      } finally {
        environmentBarrier.release();
        stopBarrier.release();
        await Promise.allSettled([sweep, stop]);
      }
      expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["startup", "full", "targeted"] as const)(
    "%s recovery preserves a live dispatch through activation",
    async (mode) => {
      if (mode !== "targeted") {
        await seedFailed(placements);
      }
      const observe = prepareTargetedAdmissionObserver(placements);
      const readCandidates = placements.readRecoveryCandidates.bind(placements);
      const candidateReads = vi.spyOn(placements, "readRecoveryCandidates");
      const harness = await createHarness(
        support.testState.stateDb,
        placements,
        mode === "targeted" ? {} : { environmentGeneration: 3 },
      );
      const coordinated = coordinate(harness);
      const tunnel = barrier();
      const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
      vi.mocked(harness.environments.startTunnel).mockImplementation(async (...args) => {
        await tunnel.wait();
        return startTunnel(...args);
      });
      let listings = 0;
      let dispatch: ReturnType<typeof coordinated.dispatch> | undefined;
      let sweep: Promise<void> | undefined;
      const beginDispatch = () => {
        dispatch = coordinated.dispatch({
          ...REQUEST,
          executionMode: mode === "targeted" ? "remote-exec" : REQUEST.executionMode,
        });
        void dispatch.catch(tunnel.reject);
        return tunnel.entered;
      };
      try {
        if (mode === "targeted") {
          await beginDispatch();
          const observation = observe(harness);
          sweep = coordinated.reconcileActive(harness.ready.environmentId);
          await observation.unitReached;
        } else {
          candidateReads.mockImplementation(async () => {
            const candidates = await readCandidates();
            if (++listings === (mode === "startup" ? 2 : 1)) {
              await beginDispatch();
            }
            return candidates;
          });
          await coordinated.reconcile(mode === "startup" ? "startup" : undefined);
        }
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "syncing",
          recoveryError: null,
        });
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      } finally {
        tunnel.release();
        await dispatch;
        await sweep;
      }
      expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["full", "targeted"] as const)(
    "%s recovery does not expire a live Move while destination admission still sees local placement",
    async (mode) => {
      const observe = prepareTargetedAdmissionObserver(placements);
      const harness = await createHarness(support.testState.stateDb, placements, {
        workspacePath: support.testState.root,
      });
      const active = await seedActive(harness);
      const coordinated = coordinate(harness);
      const destination = barrier();
      vi.spyOn(placements, "startDispatch").mockImplementation(async () => {
        await destination.wait();
        throw new Error("fixture destination unavailable");
      });
      const move = coordinated.move({
        ...REQUEST,
        source: placementSource(active),
        target: { kind: "profile", profileId: "next" },
      });
      void move.catch(destination.reject);
      let sweep: Promise<void> | undefined;
      try {
        await destination.entered;
        const intent = await placements.getPlacementMoveAsync(REQUEST.sessionId);
        expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
        const observation = observe(harness);
        sweep = coordinated.reconcileActive(mode === "targeted" ? active.environmentId : undefined);
        if (mode === "targeted") {
          await observation.unitReached;
        } else {
          await sweep;
        }
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "local",
          recoveryError: null,
        });
        expect(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toEqual(intent);
      } finally {
        destination.release();
        await expect(move).rejects.toThrow("fixture destination unavailable");
        await sweep;
      }
    },
  );

  it("lent result recovery leaves the admitted Move intent for its owner and later recovery", async () => {
    const claimWait = barrier();
    const interruption = new Error("fixture Move interrupted after claim wait");
    const harness = await createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
      runMoveBarrier: async ({ begin }) => {
        await begin();
        await claimWait.wait();
        throw interruption;
      },
    });
    const active = await seedActive(harness);
    const claim = await placements.claimTurn(placementClaim(active, "move-wait"));
    const coordinated = coordinate(harness);
    const move = coordinated.move({
      ...REQUEST,
      source: placementSource(active),
      target: { kind: "gateway" },
    });
    void move.catch(claimWait.reject);
    let recovery: Promise<void> | undefined;
    try {
      await claimWait.entered;
      const intent = await placements.getPlacementMoveAsync(REQUEST.sessionId);
      expect(intent).toBeDefined();
      recovery = coordinated.reconcileActive(active.environmentId);
      await recovery;
      expect(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toEqual(intent);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: { claimId: claim.claimId },
      });
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    } finally {
      try {
        await placements.releaseTurn(claim);
      } finally {
        claimWait.release();
        await Promise.allSettled([move, recovery]);
      }
    }
    await expect(move).rejects.toBe(interruption);
    expect(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeDefined();
    await coordinated.reconcileActive(active.environmentId);
    expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
    expect(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("preserves the final-save owner during targeted result recovery", async () => {
    const observe = prepareTargetedAdmissionObserver(placements);
    const abandon = vi.spyOn(placements, "abandonWorkspaceResult");
    const reconciliation = barrier();
    const harness = await createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
      afterReconcile: reconciliation.wait,
    });
    const active = await seedActive(harness);
    const coordinated = coordinate(harness);
    const stop = coordinated.reclaim(REQUEST);
    void stop.catch(reconciliation.reject);
    await reconciliation.entered;
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    const observation = observe(harness);
    abandon.mockClear();
    const sweep = coordinated.reconcileActive(active.environmentId!);
    try {
      await observation.unitReached;
    } finally {
      reconciliation.release();
      await stop;
      await sweep;
    }
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(abandon).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("does not start orphan discovery for sessions created after startup", async () => {
    const readChangeSnapshot = vi.spyOn(placements, "readChangeSnapshot");
    const resolveWorkspace = vi.fn(async () => ({
      kind: "local" as const,
      path: support.testState.root,
    }));
    const harness = await createHarness(support.testState.stateDb, placements, {
      resolveWorkspace,
    });
    const coordinated = coordinate(harness);
    await coordinated.reconcile("startup");

    const claim = await placements.claimTurn({
      ...REQUEST,
      owner: { kind: "local" },
      claimId: "after-startup",
      runId: "after-startup",
    });
    await placements.releaseTurnIfOwned(claim);
    await coordinated.reconcileActive();
    await coordinated.reconcileActive();

    expect(readChangeSnapshot).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it("spreads startup orphan inventories across idle sweeps and eventually reclaims every checkout", async () => {
    const template = path.join(support.testState.root, "template");
    await fs.mkdir(template);
    await git(template, "init", "--quiet", "--template=");
    const tree = await git(template, "write-tree");
    const roots = Array.from({ length: 64 }, (_, index) =>
      path.join(support.testState.root, `checkout-${String(index).padStart(2, "0")}`),
    );
    const rootsBySession = new Map<string, string>();
    for (const [index, root] of roots.entries()) {
      await fs.cp(template, root, { recursive: true });
      const sessionId = `orphan-scan-${String(index).padStart(2, "0")}`;
      rootsBySession.set(sessionId, root);
      await seedFailed(placements, sessionId);
    }
    const orphanRoot = roots.at(-1)!;
    await git(orphanRoot, "update-ref", cleanupRef, tree);
    const harness = await createHarness(support.testState.stateDb, placements, {
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

    await coordinated.reconcile("startup");
    expect(gitSpawns()).toHaveLength(0);
    for (let sweep = 0; sweep < 3; sweep++) {
      await coordinated.reconcileActive();
    }
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
    expect(inventoryRoots().toSorted()).toEqual(roots.toSorted());
    // One inventory per checkout plus the orphan's ref-queue lookup and deletion.
    expect(gitSpawns()).toHaveLength(66);
    expect(await readCleanupRef(orphanRoot)).toBe("");
  });

  it("retries startup orphan cleanup after a busy placement becomes inactive", async () => {
    const root = support.testState.root;
    await git(root, "init", "--quiet");
    await fs.writeFile(path.join(root, "result.txt"), "retired workspace result");
    await git(root, "add", "result.txt");
    const tree = await git(root, "write-tree");
    await git(root, "update-ref", cleanupRef, tree);
    await seedFailed(placements);
    const sibling = await seedFailed(placements, "sibling");
    let siblingAvailable = false;
    const harness = await createHarness(support.testState.stateDb, placements, {
      workspacePath: root,
      resolveWorkspace: async ({ sessionId }) => {
        if (sessionId === sibling.sessionId && !siblingAvailable) {
          throw new Error("fixture unavailable sibling workspace");
        }
        return { kind: "local", path: root };
      },
      environmentGeneration: 3,
    });
    const coordinated = coordinate(harness);
    await coordinated.reconcile("startup");
    const provider = barrier();
    const create = vi.mocked(harness.environments.createWithRequest).getMockImplementation()!;
    vi.mocked(harness.environments.createWithRequest).mockImplementation(async (...args) => {
      await provider.wait();
      return create(...args);
    });
    const dispatch = coordinated.dispatch(REQUEST);
    void dispatch.catch(provider.reject);
    try {
      await provider.entered;
      await coordinated.reconcileActive();
      expect(await readCleanupRef(root)).toBe(cleanupRef);
      siblingAvailable = true;
      await coordinated.reconcileActive();
      expect(await readCleanupRef(root)).toBe(cleanupRef);
    } finally {
      provider.release();
      await dispatch;
    }
    await coordinated.reclaim(REQUEST);
    expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
    expect(await readCleanupRef(root)).toBe(cleanupRef);
    await coordinated.reconcileActive();
    expect(await readCleanupRef(root)).toBe("");
  });

  it.each([1, 10])(
    "fairly retries %i unavailable startup workspaces without losing later recovery",
    async (count) => {
      const root = support.testState.root;
      await git(root, "init", "--quiet");
      const tree = await git(root, "write-tree");
      await git(root, "update-ref", cleanupRef, tree);
      const sessionIds = Array.from({ length: count }, (_, index) => `idle-${index}`);
      for (const sessionId of sessionIds) {
        await seedFailed(placements, sessionId);
      }
      const recoveredSession = sessionIds.at(-1);
      let workspaceAvailable = false;
      const attempts: string[] = [];
      const harness = await createHarness(support.testState.stateDb, placements, {
        resolveWorkspace: async ({ sessionId }) => {
          attempts.push(sessionId);
          if (!workspaceAvailable || sessionId !== recoveredSession) {
            throw new Error("fixture transient workspace resolution failure");
          }
          return { kind: "local", path: root };
        },
      });
      const coordinated = coordinate(harness);
      await coordinated.reconcile("startup");
      await coordinated.reconcileActive();
      expect(attempts).toEqual(sessionIds);
      expect(await readCleanupRef(root)).toBe(cleanupRef);

      attempts.length = 0;
      await coordinated.reconcileActive();
      expect(attempts).toEqual(sessionIds.slice(0, 8));
      workspaceAvailable = true;
      attempts.length = 0;
      await coordinated.reconcileActive();
      expect(attempts).toHaveLength(Math.min(count, 8));
      expect(attempts).toContain(recoveredSession);
      expect(await readCleanupRef(root)).toBe("");
      attempts.length = 0;
      await coordinated.reconcileActive();
      expect(attempts).toHaveLength(Math.min(count - 1, 8));
      expect(attempts).not.toContain(recoveredSession);
    },
  );

  it("a real dispatch reaches device provisioning while another placement's teardown is stuck", async () => {
    const harness = await createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
    });
    const requested = await placements.startDispatch({
      ...REQUEST,
      sessionId: "cloud",
      sessionKey: "agent:main:cloud",
    });
    const provisioning = await placements.transition({
      sessionId: "cloud",
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "cloud-environment" },
    });
    await placements.fail({
      sessionId: "cloud",
      expectedGeneration: provisioning.generation,
      recoveryError: "provider teardown required",
    });
    const destroy = barrier();
    const providerEntered = createDeferredCore();
    await support.seedReady("cloud-environment");
    const cloudEnvironments = support.createService(
      support.createProvider({
        destroy: destroy.wait,
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
    void sweep.catch(destroy.reject);
    const dispatch = destroy.entered.then(() => {
      bindDeviceWorkerAvailability(harness.environments, async () => ({
        available: true,
        node: createNodeWorkerBundleTestNode({
          nodeId: "paired-local-device",
          connId: "device-connection",
          pairingIdentity: "device-pairing",
          pairingGeneration: "device-generation",
          workerHost: {
            capacity: { total: 1, available: 1 },
            capturedExecPolicy: true,
            promptContext: 1,
          },
        }),
      }));
      return coordinated.dispatch({
        ...REQUEST,
        devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
        deviceId: "paired-local-device",
        profileId: "device:paired-local-device",
      });
    });
    releaseOwnedWork = async () => {
      destroy.release();
      await Promise.allSettled([sweep, dispatch]);
    };
    void dispatch.catch(providerEntered.reject);
    try {
      await providerEntered.promise;
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    } finally {
      destroy.release();
      await sweep;
      await dispatch;
    }
    expect(placements.get(REQUEST.sessionId)?.state).toBe("active");
  });
});
