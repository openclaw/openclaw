import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worktreeRegistryPublication } from "../../agents/worktrees/registry-publication.js";
import { insertRegistryWorktreeInDatabase } from "../../agents/worktrees/registry-run-end.worker.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import * as spawnDiagnostics from "../../process/spawn-diagnostics.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
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
import { WorkerPlacementWorkspaceUnavailableError } from "./placement-workspace-unavailable.js";
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

function observeTargetedAdmission(harness: Awaited<ReturnType<typeof createHarness>>) {
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
  return unitReached.promise;
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
  const harnessFor = (options: Parameters<typeof createHarness>[2] = {}) =>
    createHarness(support.testState.stateDb, placements, options);
  const pendingResults = () => placements.listPendingWorkspaceResultsAsync();
  async function orphanWorkspace(claimId = "orphan-claim") {
    const root = support.testState.root;
    await git(root, "init", "--quiet");
    const ref = cleanupWorkerWorkspaceResultRef(workerWorkspaceResultRef(claimId));
    await git(root, "update-ref", ref, await git(root, "write-tree"));
    return { root, ref, read: () => git(root, "for-each-ref", "--format=%(refname)", ref) };
  }
  const publishWorktree = (root: string, id: string, ownerId = `agent:main:${id}`) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        insertRegistryWorktreeInDatabase(db, { record: makeWorktreeRecord(root, id, { ownerId }) });
      },
      { database: support.testState.stateDb },
    );
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
      const harness = await harnessFor({
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
          expect(await pendingResults()).toEqual([]);
        } else {
          expect(await pendingResults()).toMatchObject([
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
      const readCandidates = placements.readRecoveryCandidates.bind(placements);
      const candidateReads = vi.spyOn(placements, "readRecoveryCandidates");
      const harness = await harnessFor(mode === "targeted" ? {} : { environmentGeneration: 3 });
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
          const admitted = observeTargetedAdmission(harness);
          sweep = coordinated.reconcileActive(harness.ready.environmentId);
          await admitted;
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
      const harness = await harnessFor({
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
        const admitted = observeTargetedAdmission(harness);
        sweep = coordinated.reconcileActive(mode === "targeted" ? active.environmentId : undefined);
        if (mode === "targeted") {
          await admitted;
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
    const harness = await harnessFor({
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
    const abandon = vi.spyOn(placements, "abandonWorkspaceResult");
    const reconciliation = barrier();
    const harness = await harnessFor({
      workspacePath: support.testState.root,
      afterReconcile: reconciliation.wait,
    });
    const active = await seedActive(harness);
    const coordinated = coordinate(harness);
    const stop = coordinated.reclaim(REQUEST);
    void stop.catch(reconciliation.reject);
    await reconciliation.entered;
    expect(await pendingResults()).toHaveLength(1);
    const admitted = observeTargetedAdmission(harness);
    abandon.mockClear();
    const sweep = coordinated.reconcileActive(active.environmentId!);
    try {
      await admitted;
    } finally {
      reconciliation.release();
      await stop;
      await sweep;
    }
    expect(await pendingResults()).toEqual([]);
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
    const harness = await harnessFor({ resolveWorkspace });
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
    const harness = await harnessFor({
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
    const harness = await harnessFor({
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

  it.each(["session", "shared-store session", "worktree", "uncertain worktree"] as const)(
    "parks unavailable orphan work until a %s owner publication and the next sweep",
    async (source) => {
      const sessionPublication = source.endsWith("session");
      const { root, ref: orphanRef, read } = await orphanWorkspace("parked-orphan");
      await seedFailed(placements);
      const target = {
        ...REQUEST,
        sessionKey: `agent:${source === "shared-store session" ? "logical" : "physical"}:canonical-orphan`,
        agentId: "physical",
        storePath: path.join(root, "sessions.sqlite"),
        ...(sessionPublication ? {} : { worktreeId: "parked-worktree" }),
      };
      let available = false;
      const resolveWorkspace = vi.fn(async () => {
        if (!available) {
          throw new WorkerPlacementWorkspaceUnavailableError("placement source changed", target);
        }
        return { kind: "local" as const, path: root };
      });
      const harness = await harnessFor({ resolveWorkspace });
      const coordinated = coordinate(harness);
      const subscribe = () => harness.service.subscribeOrphanWorkspaceChanges();
      let unsubscribe = () => {};
      const publish = (id: string) => {
        if (sessionPublication) {
          sessionChanges.emit({
            sessionKey: id,
            agentId: source === "shared-store session" ? "logical" : target.agentId,
            storePath: target.storePath,
            scope: "session-entry",
          });
        } else {
          publishWorktree(root, id);
        }
      };
      try {
        await coordinated.reconcile("startup");
        await coordinated.reconcileActive();
        expect(resolveWorkspace).toHaveBeenCalledTimes(1);
        await coordinated.reconcileActive();
        expect(resolveWorkspace).toHaveBeenCalledTimes(1);
        unsubscribe = subscribe();
        publish("unrelated");
        await coordinated.reconcileActive();
        await coordinated.reconcileActive();
        expect(resolveWorkspace).toHaveBeenCalledTimes(1);
        expect(await read()).toBe(orphanRef);

        const key = sessionPublication ? target.sessionKey : target.worktreeId!;
        unsubscribe();
        publish(key);
        await coordinated.reconcileActive();
        expect(resolveWorkspace).toHaveBeenCalledTimes(1);
        unsubscribe = subscribe();
        available = true;
        if (source === "uncertain worktree") {
          let invalidated = false;
          const stopFailure = worktreeRegistryPublication.subscribeFacts((change) => {
            if (change.kind === "committed") {
              throw new Error("fixture committed-fact installation failed");
            }
            invalidated ||= change.kind === "unknown";
          });
          try {
            publish("uncertain-other-worktree");
            expect(invalidated).toBe(true);
          } finally {
            stopFailure();
          }
        } else if (source === "worktree") {
          publishWorktree(root, "restored-worktree", target.sessionKey);
        } else {
          publish(key);
        }
        expect(resolveWorkspace).toHaveBeenCalledTimes(1);
        await coordinated.reconcileActive();
        expect(resolveWorkspace).toHaveBeenCalledTimes(2);
        expect(await read()).toBe("");
      } finally {
        unsubscribe();
      }
    },
  );

  it("retains a restoring publication received while orphan resolution is in flight", async () => {
    const { root, ref: orphanRef, read } = await orphanWorkspace("inflight-orphan");
    await seedFailed(placements);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const target = {
      ...REQUEST,
      sessionKey: "agent:physical:canonical-orphan",
      agentId: "physical",
      storePath: path.join(root, "sessions.sqlite"),
    };
    let attempts = 0;
    const resolveWorkspace = vi.fn(async () => {
      if (++attempts === 1) {
        entered.resolve();
        await release.promise;
        throw new WorkerPlacementWorkspaceUnavailableError("placement source changed", target);
      }
      return { kind: "local" as const, path: root };
    });
    const harness = await harnessFor({ resolveWorkspace });
    const unsubscribe = harness.service.subscribeOrphanWorkspaceChanges();
    const coordinated = coordinate(harness);
    await coordinated.reconcile("startup");
    const sweep = coordinated.reconcileActive();
    try {
      await entered.promise;
      sessionChanges.emit({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        storePath: target.storePath,
        scope: "session-entry",
      });
      release.resolve();
      await sweep;
      expect(resolveWorkspace).toHaveBeenCalledTimes(1);
      expect(await read()).toBe(orphanRef);
      await coordinated.reconcileActive();
      expect(resolveWorkspace).toHaveBeenCalledTimes(2);
      expect(await read()).toBe("");
    } finally {
      release.resolve();
      await sweep;
      unsubscribe();
    }
  });

  it.each([1, 10])(
    "fairly retries %i unavailable startup workspaces without losing later recovery",
    async (count) => {
      const { root } = await orphanWorkspace();
      const sessionIds = Array.from({ length: count }, (_, index) => `idle-${index}`);
      for (const sessionId of sessionIds) {
        await seedFailed(placements, sessionId);
      }
      const recoveredSession = sessionIds.at(-1);
      let workspaceAvailable = false;
      const attempts: string[] = [];
      const harness = await harnessFor({
        resolveWorkspace: async ({ sessionId }) => {
          attempts.push(sessionId);
          if (!workspaceAvailable || sessionId !== recoveredSession) {
            throw new Error("placement source changed");
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
    const harness = await harnessFor({
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
