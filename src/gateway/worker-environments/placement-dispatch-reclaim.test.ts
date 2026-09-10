import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  BUNDLE_HASH,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider, SSH_ENDPOINT } from "./service.test-support.js";
import { prepareSessionWorkerPlacementStop } from "./session-placement-lifecycle.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerWorkspaceReconcileRequest } from "./tunnel-contract.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function reclaimRequest() {
  return {
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    agentId: REQUEST.agentId,
  };
}

describe("worker placement dispatch reclaim", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "releases a failed reclaim before targeted reconciliation without losing accepted work (changed=%s)",
    async (changed) => {
      const workspacePath = path.join(root, "workspace");
      const payload = path.join(root, "worker-payload");
      await fs.mkdir(workspacePath);
      await fs.mkdir(payload);
      await fs.writeFile(path.join(workspacePath, "result.txt"), "base\n");
      await fs.writeFile(path.join(payload, "result.txt"), changed ? "worker\n" : "base\n");
      const base = await readActualWorkspaceManifest({ root: workspacePath, baseCommit: null });
      const current = await readActualWorkspaceManifest({ root: payload, baseCommit: null });
      const publishAcceptedManifest = vi.fn(async () => {});
      const fixture = createHarness(database, placementStore, { workspacePath });
      const tunnels = createWorkerTunnelManager();
      const reconcileWorkspace = vi.fn(async (request: WorkerWorkspaceReconcileRequest) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        // Use the producer's real prepared-ref/apply/publish flow, even for unchanged files.
        // An accepted marker without its staged ref is not the normal transport contract.
        const prepared = await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
          request: {
            journal: request.source.journal,
            stagedResult: request.source.stagedResult,
            localPath: request.source.path,
            remoteWorkspaceDir: request.remoteWorkspaceDir,
            baseManifestRef: request.baseManifestRef,
          },
          stagingRoot: payload,
          currentManifestRef: current.manifestRef,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
          currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
          publishAcceptedManifest,
        });
        return {
          ...prepared,
          manifestRef: current.manifestRef,
          changed,
          verifyStable: async () => {},
        };
      });
      vi.spyOn(tunnels, "start").mockImplementation(async (request) => ({
        ...(await fixture.environments.startTunnel({
          ...request,
          ownerEpoch: fixture.ready.ownerEpoch,
        })),
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        syncWorkspace: async () => ({
          mode: "git" as const,
          remoteWorkspaceDir: "/worker/workspace",
          manifestRef: base.manifestRef,
        }),
        reconcileWorkspace,
      }));
      const provisionStarted = createDeferredCore();
      const releaseProvision = createDeferredCore();
      const destroy = vi.fn(async () => {}).mockRejectedValueOnce(new Error("destroy pending"));
      const provider = createProvider({
        provision: async () => {
          provisionStarted.resolve();
          await releaseProvision.promise;
          return { leaseId: "lease-1", ssh: SSH_ENDPOINT };
        },
        destroy,
      });
      const environments = createWorkerEnvironmentService({
        store: createWorkerEnvironmentStore({ database, now: () => 1_000 }),
        getConfig: () => ({
          cloudWorkers: { profiles: { development: { provider: "fake", settings: {} } } },
        }),
        resolveProvider: (id) => (id === provider.id ? provider : undefined),
        prepareInstallation: async () => ({
          ...BUNDLE_ARTIFACT,
          protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
        }),
        bootstrapWorker: async ({ installation }) => ({
          bundleHash: installation.bundleHash,
          openclawVersion: installation.openclawVersion,
          protocolFeatures: [...installation.protocolFeatures],
        }),
        executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
        tunnelManager: tunnels,
        placementStore: createWorkerSessionPlacementGate(placementStore),
        now: () => 1_000,
      });
      const harness = createHarness(database, placementStore, {
        workspacePath,
        environmentService: environments,
      });
      const coordinated = coordinateWorkerPlacementDispatch(harness.service, (_request, run) =>
        run(),
      );
      const request = { ...REQUEST, executionMode: "remote-exec" as const };
      const dispatching = coordinated.dispatch(request);
      let outcome: Promise<unknown> | undefined;
      try {
        await Promise.race([provisionStarted.promise, dispatching]);
        expect(placementStore.get(request.sessionId)?.state).toBe("provisioning");
        outcome = coordinated.reclaim(request).catch((error: unknown) => error);
        releaseProvision.resolve();
        const active = await dispatching;
        expect(await outcome).toMatchObject({ message: "destroy pending" });
        expect(coordinated.isPlacementOperationInFlight(request.sessionId)).toBe(false);
        expect(placementStore.get(request.sessionId)?.state).toBe("draining");
        const [pending] = placementStore.listPendingWorkspaceResults();
        expect(pending).toMatchObject({
          workspaceAcceptedAtMs: 1_000,
          recoveryRequestedAtMs: 1_000,
          stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\/reclaim-/u),
        });
        expect(environments.get(active.environmentId)).toMatchObject({
          state: "destroying",
          destroyRequestedAtMs: 1_000,
        });
        expect(destroy).toHaveBeenCalledOnce();
        expect(reconcileWorkspace).toHaveBeenCalledOnce();
        expect(publishAcceptedManifest).toHaveBeenCalledOnce();
        await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
          changed ? "worker\n" : "base\n",
        );
        // Acceptance must not replay the old cloud result over subsequent local edits.
        await fs.writeFile(path.join(workspacePath, "result.txt"), "local after acceptance\n");

        await coordinated.reconcileActive(active.environmentId);

        expect(destroy).toHaveBeenCalledTimes(2);
        expect(environments.get(active.environmentId)?.state).toBe("destroyed");
        expect(placementStore.get(request.sessionId)).toMatchObject({
          state: "reclaimed",
          turnClaim: null,
        });
        expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
        expect(reconcileWorkspace).toHaveBeenCalledOnce();
        expect(publishAcceptedManifest).toHaveBeenCalledOnce();
        await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
          "local after acceptance\n",
        );
      } finally {
        releaseProvision.resolve();
        await Promise.allSettled([dispatching, outcome]);
        await environments.stop();
      }
    },
  );

  it("keeps the accepted placement draining when provider destruction is not proven", async () => {
    const harness = createHarness(database, placementStore, {
      workspacePath: path.join(root, "workspace"),
      destroyFails: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).rejects.toThrow("destroy pending");

    expect(placementStore.listPendingWorkspaceResults()).toEqual([
      expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
    ]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    await harness.service.reconcileActive();

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log).toContain("placement:draining");
    expect(harness.log).toContain("workspace:resume");
  });

  it("attaches before opening one tunnel for workspace sync and activation", async () => {
    const harness = createHarness(database, placementStore);

    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
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
  });

  it("reclaims an unchanged active placement through the fenced teardown lifecycle", async () => {
    const harness = createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    await expect(harness.service.dispatch(REQUEST)).resolves.toMatchObject({
      state: "active",
      turnClaim: null,
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    await expect(harness.service.reclaim(reclaimRequest())).resolves.toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.log.slice(-13)).toEqual([
      "placement:draining",
      "tunnel:attached",
      "workspace:quiesce",
      "workspace:reconcile",
      "workspace:verify",
      "workspace:verify-local",
      "workspace:lease",
      "workspace:verify",
      "workspace:verify-local",
      "teardown:destroy",
      "placement:reconciling",
      "placement:reclaimed",
      "teardown:stop",
    ]);
  });

  it("moves an active placement back to the Gateway without a reclaimed intermediate", async () => {
    const harness = createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const active = await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.move({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
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
    expect(placementStore.getPlacementMove(REQUEST.sessionId)).toBeUndefined();
  });

  it("carries session authorization from move source teardown into destination dispatch", async () => {
    const harness = createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    const active = await harness.service.dispatch(REQUEST);

    let authorizationChecks = 0;
    const authorize = vi.fn(() => {
      authorizationChecks += 1;
      if (authorizationChecks === 3) {
        throw new Error("session access revoked");
      }
    });
    const destinationDispatch = vi.fn(
      async (
        _request: Parameters<ReturnType<typeof createHarness>["service"]["dispatch"]>[0],
        _onTransition: Parameters<ReturnType<typeof createHarness>["service"]["dispatch"]>[1],
        destinationAuthorize: Parameters<
          ReturnType<typeof createHarness>["service"]["dispatch"]
        >[2],
      ) => {
        destinationAuthorize?.();
        throw new Error("destination dispatch lost authorization");
      },
    );
    const service = createWorkerPlacementMoveService({
      placements: placementStore,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ authorize: sourceAuthorize, begin }) => {
        sourceAuthorize?.();
        return begin();
      },
      dispatch: destinationDispatch,
      reclaimSource: async (_request, intent, sourceAuthorize) => {
        sourceAuthorize?.();
        const draining = placementStore.get(intent.sessionId);
        if (draining?.state !== "draining") {
          throw new Error("move source did not enter draining state");
        }
        const reconciling = placementStore.startReconcile({
          sessionId: draining.sessionId,
          environmentId: draining.environmentId,
          ownerEpoch: draining.activeOwnerEpoch,
          expectedGeneration: draining.generation,
        });
        const local = placementStore.completePlacementMoveSourceToLocal({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          expectedGeneration: reconciling.generation,
        });
        if (local.state !== "local") {
          throw new Error("move source did not return to local state");
        }
        return local;
      },
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(async () => {
        throw new Error("unexpected source abandonment");
      }),
      resolveDestination: async () => ({
        profileId: "destination-profile",
        executionMode: REQUEST.executionMode,
      }),
    });

    await expect(
      service.move(
        {
          sessionId: active.sessionId,
          sessionKey: active.sessionKey,
          agentId: active.agentId,
          source: {
            generation: active.generation,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
          target: { kind: "profile", profileId: "destination-profile" },
        },
        undefined,
        authorize,
      ),
    ).rejects.toThrow("session access revoked");

    expect(authorize).toHaveBeenCalledTimes(3);
    expect(destinationDispatch).toHaveBeenCalledOnce();
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "local" });
  });

  it("recovers a durable Gateway move intent before generic draining recovery", async () => {
    const harness = createHarness(database, placementStore, {
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
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      }),
    ).rejects.toThrow("move barrier interrupted");
    expect(placementStore.get(active.sessionId)).toMatchObject({ state: "draining" });
    expect(placementStore.getPlacementMove(active.sessionId)).toMatchObject({
      target: { kind: "gateway" },
      lastError: "move barrier interrupted",
    });

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = createHarness(database, restartedStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
  });

  it("completes a restarted pending result through its Gateway move intent", async () => {
    const workspacePath = path.join(root, "pending-gateway-move");
    const harness = createHarness(database, placementStore, { workspacePath });
    const active = await harness.service.dispatch(REQUEST);

    const claim = placementStore.claimTurn({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      claimId: "pending-move-claim",
      runId: "pending-move-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    const begun = placementStore.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    expect(begun.placement).toMatchObject({ state: "draining" });
    placementStore.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = createHarness(database, restartedStore, { workspacePath });
    restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await restarted.service.reconcile();

    expect(restartedStore.get(active.sessionId)).toMatchObject({ state: "local" });
    expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(restarted.log).not.toContain("placement:reclaimed");
  });

  it.each([false, true])(
    "serializes concurrent failed reclaim back to local (coordinated=%s)",
    async (coordinated) => {
      const harness = createHarness(database, placementStore);
      const requested = placementStore.startDispatch(REQUEST);
      const failed = placementStore.fail({
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
      const harness = createHarness(database, placementStore);
      if (state === "active") {
        await harness.service.dispatch(REQUEST);
      } else {
        const requested = placementStore.startDispatch(REQUEST);
        placementStore.fail({
          sessionId: REQUEST.sessionId,
          expectedGeneration: requested.generation,
          recoveryError: "dispatch failed",
        });
      }
      const destroyCalls = vi.mocked(harness.environments.destroy).mock.calls.length;
      const authorizationError = new Error("session participation changed");

      await expect(
        harness.service.reclaim(reclaimRequest(), () => {
          throw authorizationError;
        }),
      ).rejects.toBe(authorizationError);

      expect(harness.placements.current()).toMatchObject({ state });
      expect(harness.environments.destroy).toHaveBeenCalledTimes(destroyCalls);
    },
  );

  it("retains and reports cloud versions that conflict during an idle reclaim", async () => {
    const harness = createHarness(database, placementStore, {
      reconcileConflictPaths: ["src/local.ts"],
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).resolves.toMatchObject({
      state: "reclaimed",
    });

    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
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
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("reclaims an unchanged worker without clearing a retained keep-local conflict", async () => {
    const priorConflict = {
      paths: ["notes.md"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(database, placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: MANIFEST_REF,
    });

    expect(harness.placements.current()).toMatchObject({ workspaceResultConflict: priorConflict });
    expect(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("retires only the exact unclaimed safe placement generation", () => {
    const claim = placementStore.claimTurn({
      ...REQUEST,
      owner: { kind: "local" },
      claimId: "retirement-claim",
      runId: "retirement-run",
    });
    expect(() =>
      placementStore.retireSessionPlacement({
        sessionId: REQUEST.sessionId,
        expectedState: "local",
        expectedGeneration: 0,
      }),
    ).toThrow("changed before retirement");
    placementStore.releaseTurn(claim);
    placementStore.retireSessionPlacement({
      sessionId: REQUEST.sessionId,
      expectedState: "local",
      expectedGeneration: 0,
    });
    expect(placementStore.get(REQUEST.sessionId)).toBeUndefined();

    const requested = placementStore.startDispatch(REQUEST);
    const failed = placementStore.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "dispatch failed",
    });
    for (const stale of [
      { expectedState: "local" as const, expectedGeneration: 0 },
      { expectedState: "failed" as const, expectedGeneration: failed.generation - 1 },
    ]) {
      expect(() =>
        placementStore.retireSessionPlacement({ sessionId: REQUEST.sessionId, ...stale }),
      ).toThrow("changed before retirement");
    }
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      generation: failed.generation,
    });
  });

  it("retires a reclaimed placement with its child rows and conflict projection", () => {
    const harness = createHarness(database, placementStore);
    const active = harness.placements.seedActive(7);
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const claim = placementStore.claimTurn({
      ...REQUEST,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "retirement-worker-claim",
      runId: "retirement-worker-run",
    });
    placementStore.recordWorkspaceResultConflict(claim, {
      paths: ["conflicted.txt"],
      stagedResultRef: `refs/openclaw/worker-results/${claim.claimId}`,
    });
    placementStore.releaseTurn(claim);

    const basePack = Buffer.from("retirement workspace base pack");
    placementStore.beginWorkspaceReconciliation(
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
      },
      {
        version: 1,
        temporaryNonce: "c".repeat(32),
        baseManifestRef: active.workspaceBaseManifestRef,
        currentManifestRef: `sha256:${"d".repeat(64)}`,
        baseEntries: [],
        appliedEntries: [],
        baseTree: "e".repeat(40),
        basePackSha256: createHash("sha256").update(basePack).digest("hex"),
        basePack,
      },
    );
    const draining = placementStore.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = placementStore.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const reclaimed = placementStore.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    expect(placementStore.listWorkspaceReconciliationOwners()).toHaveLength(1);
    expect(placementStore.get(active.sessionId)?.workspaceResultConflict).toBeDefined();

    placementStore.retireSessionPlacement({
      sessionId: reclaimed.sessionId,
      expectedState: "reclaimed",
      expectedGeneration: reclaimed.generation,
    });

    expect(placementStore.get(active.sessionId)).toBeUndefined();
    expect(placementStore.listWorkspaceReconciliationOwners()).toEqual([]);
    placementStore.claimTurn({
      ...REQUEST,
      owner: { kind: "local" },
      claimId: "replacement-local-claim",
      runId: "replacement-local-run",
    });
    expect(placementStore.get(active.sessionId)).not.toHaveProperty("workspaceResultConflict");
  });

  it("applies a prepared staged result before requiring its manifest commit", async () => {
    const harness = createHarness(database, placementStore, {
      reconcileCommitsManifest: false,
      reconcileCommitsManifestOnApply: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
    });

    expect(harness.log).toContain("workspace:apply-prepared");
  });

  it("claims and cancels a reclaim workspace result atomically", async () => {
    const harness = createHarness(database, placementStore);
    const active = await harness.service.dispatch(REQUEST);
    const claim = placementStore.claimReclaimWorkspaceResult({
      ...REQUEST,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "reclaim-atomic",
      runId: "reclaim-atomic",
    });

    expect(placementStore.get(active.sessionId)?.turnClaim).toMatchObject({
      claimId: claim.claimId,
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: active.sessionId, claimId: claim.claimId },
    ]);

    expect(placementStore.cancelWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);
  });

  it("releases a failed stop claim so reclaim can be retried", async () => {
    const workspacePath = path.join(root, "retry-workspace");
    await fs.mkdir(workspacePath);
    const initialized = await runCommandWithTimeout(
      ["git", "-C", workspacePath, "init", "--quiet"],
      { timeoutMs: 10_000 },
    );
    expect(initialized.code).toBe(0);
    const harness = createHarness(database, placementStore, {
      reconcileFailureCount: 1,
      workspacePath,
    });
    await harness.service.dispatch(REQUEST);
    const request = reclaimRequest();

    await expect(harness.service.reclaim(request)).rejects.toThrow("workspace conflict");
    expect(harness.placements.current()).toMatchObject({ state: "draining", turnClaim: null });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

    await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a replaced reclaimed owner after waiting to enter the lifecycle fence", async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const harness = createHarness(database, placementStore, {
      runReclaimBarrier: async ({ beforeDrain, begin, reclaim, authorize }) => {
        entered.resolve();
        await resume.promise;
        authorize?.();
        beforeDrain?.();
        const placement = begin();
        return placement.state === "reclaimed"
          ? placement
          : await reclaim({ kind: "local", path: "/gateway/workspace" }, placement, authorize);
      },
    });
    const active = await harness.service.dispatch(REQUEST);
    const stop = prepareSessionWorkerPlacementStop({
      ...REQUEST,
      action: "delete",
      context: {
        workerSessionPlacementService: placementStore,
        workerPlacementDispatchService: harness.service,
        workerEnvironmentService: harness.environments,
      },
    })();
    const rejected = expect(stop).rejects.toThrow("cloud worker placement identity changed");
    await entered.promise;
    try {
      const peer = createHarness(database, placementStore);
      peer.markEnvironmentOwnerEpoch(2);
      const reclaimed = await peer.service.reclaim(REQUEST);
      placementStore.retireSessionPlacement({
        sessionId: reclaimed.sessionId,
        expectedState: "reclaimed",
        expectedGeneration: reclaimed.generation,
      });
      const replacement = createHarness(database, placementStore, { environmentGeneration: 2 });
      replacement.placements.seedActive(2);
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

  it("completes a session stop when a dropped tunnel loses the race to durable teardown", async () => {
    const harness = createHarness(database, placementStore, {
      terminalizeReclaimOnTunnelDrop: true,
    });
    await harness.service.dispatch(REQUEST);

    const request = reclaimRequest();
    const first = prepareSessionWorkerPlacementStop({
      ...request,
      action: "delete",
      context: {
        workerSessionPlacementService: placementStore,
        workerPlacementDispatchService: harness.service,
        workerEnvironmentService: harness.environments,
      },
    })();
    const coalesced = harness.service.reclaim(request);

    await expect(Promise.all([first, coalesced])).resolves.toMatchObject([
      undefined,
      { state: "reclaimed", turnClaim: null },
    ]);

    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
    expect(harness.environments.get(REQUEST.sessionId)).toMatchObject({ state: "destroyed" });
    expect(harness.log).toContain("teardown:destroy");
  });

  it("does not hide an unrelated failure after durable teardown", async () => {
    const harness = createHarness(database, placementStore, {
      terminalizeReclaimOnTunnelDrop: true,
      terminalizedReclaimError: new Error("credential rejected"),
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).rejects.toThrow("credential rejected");
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("releases a failed final-sync claim so reclaim with a retained conflict is retryable", async () => {
    const priorConflict = {
      paths: ["data.txt"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(database, placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      reconcileChanged: false,
      leaseFailureCount: 1,
    });
    await harness.service.dispatch(REQUEST);
    const request = reclaimRequest();

    await expect(harness.service.reclaim(request)).rejects.toThrow("workspace quiescence expired");
    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      turnClaim: null,
    });
    expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

    await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      workspaceResultConflict: priorConflict,
    });
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("keeps a changed result fenced when quiescence fails after apply", async () => {
    const harness = createHarness(database, placementStore, { leaseFailureCount: 1 });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).rejects.toThrow(
      "workspace quiescence expired",
    );

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, stagedResultRef: null },
    ]);
  });

  it.each([1, 2])(
    "retries an unchanged result when final fence step %i observes a write",
    async (verifyFailureCall) => {
      const priorConflict = {
        paths: ["data.txt"],
        stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
      };
      const harness = createHarness(database, placementStore, {
        priorWorkspaceResultConflict: priorConflict,
        reconcileChanged: false,
        verifyFailureCall,
      });
      await harness.service.dispatch(REQUEST);
      const request = reclaimRequest();

      await expect(harness.service.reclaim(request)).rejects.toThrow(
        "workspace changed after reconciliation",
      );
      expect(harness.placements.current()).toMatchObject({ state: "draining", turnClaim: null });
      expect(placementStore.listPendingWorkspaceResults()).toEqual([]);

      await expect(harness.service.reclaim(request)).resolves.toMatchObject({ state: "reclaimed" });
      expect(harness.placements.current()).toMatchObject({
        state: "reclaimed",
        workspaceResultConflict: priorConflict,
      });
    },
  );

  it("keeps a committed failed stop result fenced for recovery", async () => {
    const priorConflict = {
      paths: ["notes.md"],
      stagedResultRef: "refs/openclaw/worker-results/prior-conflict",
    };
    const harness = createHarness(database, placementStore, {
      priorWorkspaceResultConflict: priorConflict,
      verifyFails: true,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(reclaimRequest())).rejects.toThrow(
      "workspace changed after reconciliation",
    );

    expect(harness.placements.current()).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: harness.reconciledManifestRef,
      turnClaim: { owner: "worker" },
    });
    expect(placementStore.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, stagedResultRef: null },
    ]);
  });

  it("a lifecycle owner can reclaim while another reclaim waits behind its fence", async () => {
    const scope = root;
    const queued = createDeferredCore();
    const locked = createDeferredCore();
    const resume = createDeferredCore();
    const identities = [REQUEST.sessionKey, REQUEST.sessionId];
    const harness = createHarness(database, placementStore, {
      reconcileChanged: false,
      reconcileCommitsManifest: false,
      runReclaimBarrier: async ({ authorize, beforeDrain, begin, reclaim }) => {
        queued.resolve();
        return await runExclusiveSessionLifecycleMutation({
          scope,
          identities,
          run: async () => {
            authorize?.();
            beforeDrain?.();
            const placement = begin();
            return placement.state === "reclaimed"
              ? placement
              : await reclaim({ kind: "local", path: root }, placement, authorize);
          },
        });
      },
    });
    await harness.service.dispatch(REQUEST);
    const owner = runExclusiveSessionLifecycleMutation({
      scope,
      identities,
      run: async () => {
        locked.resolve();
        await resume.promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            harness.service.reclaim(REQUEST),
            new Promise<"blocked">((resolve) => {
              timer = setTimeout(() => resolve("blocked"), 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
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
