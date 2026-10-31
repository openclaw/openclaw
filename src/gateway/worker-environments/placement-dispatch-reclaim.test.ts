import path from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { expectPlacement, makeClaimInput } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  placementClaim,
  placementSource,
  placementTransition,
  journalOwner,
} from "./placement-suite.test-support.js";
import { prepareSessionWorkerPlacementStop } from "./session-placement-lifecycle.js";
import { workspaceJournal } from "./workspace-manifest-fixtures.test-support.js";
import * as workspaceResultStaging from "./workspace-result-staging.js";

const tempDirs = useStateDatabaseTempDirs();
const it = createCommandTest();

describe("worker placement dispatch reclaim", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    root = tempDirs.make("openclaw-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  const unchangedHarness = (options: Parameters<typeof createHarness>[2] = {}) =>
    createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      ...options,
    });

  it("admits an unrelated provider provision after Stop while another provision never settles", async () => {
    const harness = await createHarness(database, placementStore, {
      workspacePath: root,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const coordinated = coordinateWorkerPlacementDispatch(harness.service, (_request, run) =>
      run(),
    );
    await coordinated.dispatch(REQUEST);
    const provisionEntered = createDeferredCore();
    const nextProvisionEntered = createDeferredCore();
    const provision = createDeferredCore<typeof harness.ready>();
    const create = vi.mocked(harness.environments.createWithRequest);
    create
      .mockClear()
      .mockImplementationOnce(async () => {
        provisionEntered.resolve();
        return await provision.promise;
      })
      .mockImplementation(async () => {
        nextProvisionEntered.resolve();
        return await provision.promise;
      });
    void coordinated
      .dispatch({
        ...REQUEST,
        sessionId: "pending-session",
        sessionKey: "agent:main:pending-session",
      })
      .catch(provisionEntered.reject);
    await provisionEntered.promise;
    await expect(coordinated.reclaim(REQUEST)).resolves.toMatchObject({ state: "reclaimed" });

    void coordinated
      .dispatch({
        ...REQUEST,
        sessionId: "new-session",
        sessionKey: "agent:main:new-session",
      })
      .catch(nextProvisionEntered.reject);
    await nextProvisionEntered.promise;
    expect(create).toHaveBeenCalledTimes(2);
    expect(placementStore.get("new-session")).toMatchObject({ state: "provisioning" });
    expect(placementStore.get("pending-session")).toMatchObject({ state: "provisioning" });
  });

  it("keeps the accepted placement draining when provider destruction is not proven", async () => {
    const harness = await createHarness(database, placementStore, {
      workspacePath: path.join(root, "workspace"),
      destroyFails: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow("destroy pending");

    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    await harness.service.reconcileActive();

    expectPlacement(placementStore, "draining", {
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: { owner: "worker" },
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { workspaceAcceptedAtMs: expect.any(Number) },
    ]);
    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it("orders activation and fenced reclaim while retaining a keep-local conflict", async () => {
    const priorConflict = {
      paths: ["notes.md"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = await unchangedHarness({ priorWorkspaceResultConflict: priorConflict });
    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
      turnClaim: null,
      environmentId: harness.ready.environmentId,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: MANIFEST_REF,
      remoteWorkspaceDir: "/worker/workspace",
      workerBundleHash: BUNDLE_HASH,
    });
    expect(harness.log).toEqual([
      "barrier",
      "placement:requested",
      "workspace",
      "placement:provisioning",
      "create",
      "placement:syncing",
      "attach",
      "tunnel:attached",
      "sync",
      "placement:starting",
      "activation",
      "placement:active",
    ]);
    expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: MANIFEST_REF,
    });
    expect(harness.placements.current()).toMatchObject({ workspaceResultConflict: priorConflict });
    expect(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.log.slice(-12)).toEqual([
      "placement:draining",
      "workspace",
      "tunnel:attached",
      "workspace:quiesce",
      "workspace:reconcile",
      "workspace:lease",
      "workspace:verify",
      "workspace:verify-local",
      "teardown:stop",
      "teardown:destroy",
      "placement:reconciling",
      "placement:reclaimed",
    ]);
  });

  it("moves an active placement back to the Gateway without a reclaimed intermediate", async () => {
    const harness = await unchangedHarness();
    const active = await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.move({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        source: placementSource(active),
        target: { kind: "gateway" },
      }),
    ).resolves.toMatchObject({
      state: "local",
      environmentId: null,
      activeOwnerEpoch: null,
    });

    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("placement:reconciling");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(await placementStore.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
  });

  it.each(["stop", "move"])(
    "finishes %s after authority closes during committed environment destruction",
    async (operation) => {
      let authorized = true;
      const harness = await createHarness(database, placementStore, {
        reconcileChanged: false,
        reconcileCommitsManifest: false,
        afterDestroy: () => {
          authorized = false;
        },
      });
      const active = await harness.service.dispatch(REQUEST);
      const authorize = () => {
        if (!authorized) {
          throw new Error("session access revoked after environment destruction");
        }
      };
      const outcome =
        operation === "stop"
          ? harness.service.reclaim(REQUEST, authorize)
          : harness.service.move(
              {
                ...REQUEST,
                source: placementSource(active),
                target: { kind: "gateway" },
              },
              undefined,
              authorize,
            );
      await expect(outcome).resolves.toMatchObject({
        state: operation === "stop" ? "reclaimed" : "local",
        turnClaim: null,
      });
      expect(harness.environments.destroy).toHaveBeenCalledOnce();
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    },
  );

  it("carries session authorization from move source teardown into destination dispatch", async () => {
    let authorized = true;
    const harness = await unchangedHarness({
      afterDestroy: () => {
        authorized = false;
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    await expect(
      harness.service.move(
        {
          ...REQUEST,
          source: placementSource(active),
          target: { kind: "profile", profileId: "destination-profile" },
        },
        undefined,
        () => {
          if (!authorized) {
            throw new Error("session access revoked");
          }
        },
      ),
    ).rejects.toThrow("session access revoked");
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
  });

  it("recovers a durable Gateway move intent before generic draining recovery", async () => {
    const harness = await createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      failMoveAfterBegin: true,
    });
    const active = await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.move({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        source: placementSource(active),
        target: { kind: "gateway" },
      }),
    ).rejects.toThrow("move barrier interrupted");
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "draining" });
    expect(await placementStore.getPlacementMoveAsync(active.sessionId)).toMatchObject({
      target: { kind: "gateway" },
      lastError: "move barrier interrupted",
    });

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = await createHarness(database, restartedStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(await restartedStore.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
  });

  it("completes a restarted pending result through its Gateway move intent", async () => {
    const workspacePath = path.join(root, "pending-gateway-move");
    const harness = await createHarness(database, placementStore, { workspacePath });
    const active = await harness.service.dispatch(REQUEST);

    const claim = await placementStore.claimTurn(placementClaim(active, "pending-move"));
    const begun = await placementStore.beginPlacementMove({
      sessionId: active.sessionId,
      source: placementSource(active),
      target: { kind: "gateway" },
    });
    expect(begun.placement).toMatchObject({ state: "draining" });
    await placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = await createHarness(database, restartedStore, { workspacePath });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(await restartedStore.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
    expect(restarted.log).not.toContain("placement:reclaimed");
  });

  it.each([false, true])(
    "serializes concurrent failed reclaim back to local (coordinated=%s)",
    async (coordinated) => {
      const harness = await createHarness(database, placementStore);
      const requested = await placementStore.startDispatch(REQUEST);
      const failed = await placementStore.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "device worker is offline",
      });

      const service = coordinated
        ? coordinateWorkerPlacementDispatch(harness.service, (_request, run) => run())
        : harness.service;
      const results = await Promise.all([service.reclaim(REQUEST), service.reclaim(REQUEST)]);
      expect(results[1]).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        state: "local",
        generation: failed.generation + 1,
        environmentId: null,
        recoveryError: null,
        terminalReason: null,
        terminalAtMs: null,
      });

      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "failed"] as const)(
    "rejects %s reclaim before its first durable cleanup action when authorization changes",
    async (state) => {
      const harness = await createHarness(database, placementStore);
      if (state === "active") {
        await harness.service.dispatch(REQUEST);
      } else {
        const requested = await placementStore.startDispatch(REQUEST);
        await placementStore.fail({
          sessionId: REQUEST.sessionId,
          expectedGeneration: requested.generation,
          recoveryError: "dispatch failed",
        });
      }
      const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
      const authorizationError = new Error("session participation changed");

      await expect(
        harness.service.reclaim(REQUEST, () => {
          throw authorizationError;
        }),
      ).rejects.toBe(authorizationError);

      expect(harness.placements.current()).toMatchObject({ state });
      expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
    },
  );

  it("retains and reports cloud versions that conflict during an idle reclaim", async () => {
    // This lifecycle fixture records only a synthetic conflict ref; Git history has its own proof.
    using history = vi.spyOn(workspaceResultStaging, "adoptStagedWorkerWorkspaceHistory");
    history.mockResolvedValue(undefined);
    const harness = await createHarness(database, placementStore, {
      reconcileConflictPaths: ["src/local.ts"],
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({ state: "reclaimed" });

    expectPlacement(placementStore, "reclaimed", {
      workspaceResultConflict: {
        paths: ["src/local.ts"],
        stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\/reclaim-/u),
        totalCount: 1,
      },
    });

    expect(harness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\/reclaim-/u),
      totalCount: 1,
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each(["retireSessionPlacementAsync"] as const)(
    "%s retires only the exact unclaimed safe placement generation",
    async (method) => {
      const retire = async (input: Parameters<PlacementStore[typeof method]>[0]) =>
        placementStore[method](input);
      const claim = await placementStore.claimTurn({
        ...REQUEST,
        owner: { kind: "local" },
        claimId: "retirement-claim",
        runId: "retirement-run",
      });
      await expect(
        retire({
          sessionId: REQUEST.sessionId,
          expectedState: "local",
          expectedGeneration: 0,
        }),
      ).rejects.toThrow("during an active turn");
      await placementStore.releaseTurn(claim);
      const retirement = {
        sessionId: REQUEST.sessionId,
        expectedState: "local" as const,
        expectedGeneration: 0,
      };
      await retire(retirement);
      expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();
      await expect(placementStore.retireSessionPlacementAsync(retirement)).resolves.toBeUndefined();

      const requested = await placementStore.startDispatch(REQUEST);
      const failed = await placementStore.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "dispatch failed",
      });
      for (const stale of [
        { expectedState: "local" as const, expectedGeneration: 0 },
        { expectedState: "failed" as const, expectedGeneration: failed.generation - 1 },
      ]) {
        await expect(retire({ sessionId: REQUEST.sessionId, ...stale })).rejects.toThrow(
          "changed before retirement",
        );
      }
      expectPlacement(placementStore, "failed", { generation: failed.generation });
    },
  );

  it.each(["worker", "worker-after-peer"] as const)(
    "retires a reclaimed placement with child rows and clears %s conflict projection",
    async (mode) => {
      const harness = await createHarness(database, placementStore);
      const active = await harness.placements.seedActive(7);
      if (active.state !== "active") {
        throw new Error("expected active worker placement");
      }
      const claim = await placementStore.claimTurn(
        makeClaimInput(active, "retirement-worker-claim", "retirement-worker-run"),
      );
      await placementStore.markWorkspaceResultPending(claim);
      placementStore.recordWorkspaceResultConflict(claim, {
        paths: ["conflicted.txt"],
        stagedResultRef: `refs/openclaw/worker-results/${claim.claimId}`,
      });
      await placementStore.acceptWorkspaceResult(claim);
      await placementStore.completeWorkspaceResultAndReleaseTurn(claim);

      const basePack = Buffer.from("retirement workspace base pack");
      await placementStore.beginWorkspaceReconciliation(
        journalOwner(active),
        workspaceJournal(active.workspaceBaseManifestRef, `sha256:${"d".repeat(64)}`, {
          temporaryNonce: "c".repeat(32),
          baseTree: "e".repeat(40),
          basePack,
        }),
      );
      const draining = await placementStore.startDrain(placementTransition(active));
      const reconciling = await placementStore.startReconcile({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      const reclaimed = await placementStore.transition({
        sessionId: active.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      });
      expect(await placementStore.listWorkspaceReconciliationOwners()).toHaveLength(1);
      expect(placementStore.get(active.sessionId)?.workspaceResultConflict).toBeDefined();

      const retirement = {
        sessionId: reclaimed.sessionId,
        expectedState: "reclaimed" as const,
        expectedGeneration: reclaimed.generation,
      };
      if (mode === "worker-after-peer") {
        const peer = createWorkerSessionPlacementStore({ database });
        await peer.retireSessionPlacementAsync(retirement);
        await placementStore.retireSessionPlacementAsync(retirement);
      } else {
        await placementStore.retireSessionPlacementAsync(retirement);
      }

      expect(placementStore.get(active.sessionId)).toBeUndefined();
      expect(await placementStore.listWorkspaceReconciliationOwners()).toEqual([]);
      await placementStore.claimTurn({
        ...REQUEST,
        owner: { kind: "local" },
        claimId: "replacement-local-claim",
        runId: "replacement-local-run",
      });
      expect(placementStore.get(active.sessionId)).not.toHaveProperty("workspaceResultConflict");
    },
  );

  it("applies a prepared staged result before requiring its manifest commit", async () => {
    const harness = await createHarness(database, placementStore, {
      reconcileCommitsManifest: false,
      reconcileCommitsManifestOnApply: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });

    expect(harness.log).toContain("workspace:apply-prepared");
  });

  it("claims and cancels a reclaim workspace result atomically", async () => {
    const harness = await createHarness(database, placementStore);
    const active = await harness.service.dispatch(REQUEST);
    const claim = await placementStore.claimReclaimWorkspaceResult(
      makeClaimInput(active, "reclaim-atomic"),
    );

    expect(placementStore.get(active.sessionId)?.turnClaim).toMatchObject({
      claimId: claim.claimId,
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: active.sessionId, claimId: claim.claimId },
    ]);

    expect(await placementStore.cancelWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      turnClaim: null,
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("releases a failed stop claim so reclaim can be retried", async ({ command }) => {
    const workspacePath = path.join(root, "retry-workspace");
    const initialized = await command.run("git", ["init", "--quiet", workspacePath], {
      timeout: 10_000,
    });
    expect(initialized.status).toBe(0);
    const harness = await createHarness(database, placementStore, {
      reconcileFailureCount: 1,
      workspacePath,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow("workspace conflict");
    expectPlacement(placementStore, "draining", { turnClaim: null });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);

    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a replaced reclaimed owner after waiting to enter the lifecycle fence", async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const harness = await createHarness(database, placementStore, {
      runReclaimBarrier: async ({ beforeDrain, begin, reclaim, authorize }) => {
        entered.resolve();
        await resume.promise;
        authorize?.();
        beforeDrain?.();
        const placement = await begin(authorize);
        return placement.state === "reclaimed"
          ? placement
          : await reclaim({ kind: "local", path: "/gateway/workspace" }, placement, authorize);
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    const stop = (
      await prepareSessionWorkerPlacementStop({
        ...REQUEST,
        action: "delete",
        context: {
          workerSessionPlacementService: placementStore,
          workerPlacementDispatchService: harness.service,
          workerEnvironmentService: harness.environments,
        },
      })
    ).stop();
    const rejected = expect(stop).rejects.toThrow("cloud worker placement identity changed");
    await entered.promise;
    try {
      const peer = await createHarness(database, placementStore);
      peer.markEnvironmentOwnerEpoch(2);
      const reclaimed = await peer.service.reclaim(REQUEST);
      await placementStore.retireSessionPlacementAsync({
        sessionId: reclaimed.sessionId,
        expectedState: "reclaimed",
        expectedGeneration: reclaimed.generation,
      });
      const replacement = await createHarness(database, placementStore, {
        environmentGeneration: 2,
      });
      await replacement.placements.seedActive(2);
      replacement.markEnvironmentOwnerEpoch(2);
      const settled = await replacement.service.reclaim(REQUEST);
      expect(settled.environmentId).not.toBe(active.environmentId);
      resume.resolve();
      await rejected;
      expect(placementStore.get(REQUEST.sessionId)).toEqual(settled);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await rejected;
    }
  });

  it("preserves completed teardown and permits retry after a late tunnel disconnect", async () => {
    const harness = await createHarness(database, placementStore, {
      terminalizeReclaimOnTunnelDrop: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(
      "Worker tunnel owner is no longer connected",
    );

    expectPlacement(placementStore, "reclaimed", { turnClaim: null });
    expect(harness.environments.get(REQUEST.sessionId)).toMatchObject({ state: "destroyed" });
    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({
      state: "reclaimed",
      turnClaim: null,
    });
    expect(harness.log.filter((event) => event === "teardown:destroy")).toHaveLength(1);
  });

  it("does not hide an unrelated failure after durable teardown", async () => {
    const harness = await createHarness(database, placementStore, {
      terminalizeReclaimOnTunnelDrop: true,
      terminalizedReclaimError: new Error("credential rejected"),
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow("credential rejected");
    expectPlacement(placementStore, "reclaimed", { turnClaim: null });
  });

  it.each(["lease-before", "write-before", "lease-after", "write-after"] as const)(
    "preserves the result fence and retry policy for %s",
    async (failure) => {
      const afterApply = failure.endsWith("after");
      const writeFailure = failure.startsWith("write");
      const priorConflict = {
        paths: [writeFailure && afterApply ? "notes.md" : "data.txt"],
        stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
      };
      const harness = await createHarness(database, placementStore, {
        ...(failure !== "lease-after" ? { priorWorkspaceResultConflict: priorConflict } : {}),
        ...(!afterApply ? { reconcileChanged: false } : {}),
        ...(writeFailure
          ? { verifyFailurePhase: afterApply ? "after-apply" : "before-apply" }
          : afterApply
            ? { leaseFailureCall: 2 }
            : { leaseFailureCount: 1 }),
        ...(failure === "write-after"
          ? { reconcileCommitsManifest: false, reconcileCommitsManifestOnApply: true }
          : {}),
      });
      await harness.service.dispatch(REQUEST);
      await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(
        writeFailure ? "workspace changed after reconciliation" : "workspace quiescence expired",
      );
      expectPlacement(placementStore, "draining", {
        turnClaim: afterApply ? { owner: "worker" } : null,
        ...(failure === "write-after"
          ? { workspaceBaseManifestRef: harness.reconciledManifestRef }
          : {}),
      });
      if (afterApply) {
        expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
          { workspaceAcceptedAtMs: null, stagedResultRef: null },
        ]);
      } else {
        expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
        await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({
          state: "reclaimed",
        });
        expectPlacement(placementStore, "reclaimed", { workspaceResultConflict: priorConflict });
        if (failure === "lease-before") {
          expect(harness.environments.destroy).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("a lifecycle owner can reclaim while another reclaim waits behind its fence", async () => {
    const scope = root;
    const queued = createDeferredCore();
    const locked = createDeferredCore();
    const resume = createDeferredCore();
    const identities = [REQUEST.sessionKey, REQUEST.sessionId];
    const harness = await createHarness(database, placementStore, {
      workspacePath: root,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      runReclaimBarrier: async ({ authorize, beforeDrain, begin, reclaim }) => {
        queued.resolve();
        return await runSessionMutation({
          scope,
          identities,
          run: async () => {
            authorize?.();
            beforeDrain?.();
            const placement = await begin(authorize);
            return placement.state === "reclaimed"
              ? placement
              : await reclaim({ kind: "local", path: root }, placement, authorize);
          },
        });
      },
    });
    await harness.service.dispatch(REQUEST);
    const owner = runSessionMutation({
      scope,
      identities,
      run: async () => {
        locked.resolve();
        await resume.promise;
        return await harness.service.reclaim(REQUEST);
      },
    });
    await locked.promise;
    const competing = harness.service.reclaim(REQUEST);
    await queued.promise;
    resume.resolve();
    try {
      expect(await owner).toMatchObject({ state: "reclaimed" });
    } finally {
      await Promise.allSettled([owner, competing]);
    }
  });
});
