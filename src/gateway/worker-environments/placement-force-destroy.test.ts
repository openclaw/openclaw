import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { summarizeWorkerEnvironment } from "./environment-summary.js";
import {
  type PlacementStore,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("forced worker environment destruction", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-force-destroy-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serializes with workspace work and abandons an applied result fence", async () => {
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const harness = await createHarness(database, placementStore, {
      workspaceOperations,
      workspacePath: root,
    });
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const active = await harness.placements.seedActive(harness.attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = await placementStore.claimTurn({
      ...REQUEST,
      claimId: "force-destroy-claim",
      runId: "force-destroy-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    await placementStore.markWorkspaceResultPending(claim);
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const appliedManifestRef = harness.reconciledManifestRef;
    await placementStore.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "a".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: appliedManifestRef,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });
    await placementStore.updateWorkspaceBaseManifest({ claim, manifestRef: appliedManifestRef });
    expect((await placementStore.loadWorkspaceReconciliation(owner))?.appliedManifestRef).toBe(
      appliedManifestRef,
    );

    const releaseWorkspaceOperation = createDeferred();
    const workspaceOperation = workspaceOperations.run(active.environmentId, async () => {
      await releaseWorkspaceOperation.promise;
    });
    const forceDestroy = harness.service.forceDestroyEnvironment(active.environmentId);
    await Promise.resolve();
    expect(harness.environments.destroy).not.toHaveBeenCalled();

    releaseWorkspaceOperation.resolve();
    await expect(Promise.all([workspaceOperation, forceDestroy])).resolves.toEqual([
      undefined,
      expect.objectContaining({ state: "destroyed" }),
    ]);
    expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "Worker result abandoned by forced operator teardown",
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(await placementStore.listWorkspaceReconciliationOwners()).toEqual([]);
  });

  it.each([
    { failure: "tunnel stop", state: "draining" as const },
    { failure: "provider stop", state: "destroying" as const },
  ])("stays successful after $failure failure", async ({ state }) => {
    const harness = await createHarness(database, placementStore, {
      destroyFails: true,
      destroyFailureState: state,
      workspacePath: root,
    });
    await harness.placements.seedActive(harness.attached.ownerEpoch);
    const onCleanupError = vi.fn();

    await expect(
      harness.service.forceDestroyEnvironment(harness.ready.environmentId, onCleanupError),
    ).resolves.toMatchObject({ state });

    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: "Worker result abandoned by forced operator teardown",
    });
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "destroy pending" }),
    );
  });

  it("retries remote teardown when a failed rollback journal remains", async () => {
    const harness = await createHarness(database, placementStore, {
      destroyFails: true,
      destroyFailureState: "destroying",
      failAt: "workspace",
    });
    const active = await harness.placements.seedActive(harness.attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    await placementStore.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"e".repeat(64)}`,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update("").digest("hex"),
      basePack: Buffer.alloc(0),
    });

    await expect(
      harness.service.forceDestroyEnvironment(active.environmentId),
    ).resolves.toMatchObject({ state: "destroying" });
    expect(await placementStore.listWorkspaceReconciliationOwners()).toEqual([owner]);
    vi.mocked(harness.environments.destroy).mockClear();

    await harness.service.reconcileActive(active.environmentId);

    expect(harness.environments.destroy).toHaveBeenCalledExactlyOnceWith(active.environmentId);
  });
});

describe("forced destruction across Gateway restart", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains forced intent and the latest dedicated-provider teardown failure after restart", async () => {
    const environmentId = "worker-forced-provider-failure";
    await support.seedReadyNodeDesktop(environmentId);
    const attached = await support.testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: { ...support.attachedPatch(environmentId, REQUEST.sessionId), sharedHost: false },
    });
    let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const active = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    const destroy = vi
      .fn(async () => {})
      .mockRejectedValueOnce(
        new Error(`provider deletion refused: ${"detail ".repeat(300)}quota blocked`),
      )
      .mockRejectedValueOnce(new Error("provider deletion still blocked"));
    const createService = async () =>
      support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn"],
          inspect: async () => ({ status: "active", sharedHost: false }),
          destroy,
        }),
        {
          placementStore: createWorkerSessionPlacementGate(placements, {
            recoveryPlacements: await placements.listAsync(),
          }),
        },
      );
    const harness = await createHarness(support.testState.stateDb, placements, {
      environmentService: await createService(),
      workspacePath: support.testState.root,
    });

    await expect(harness.service.forceDestroyEnvironment(environmentId)).rejects.toThrow(
      "provider deletion refused",
    );
    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      turnClaim: null,
    });

    await support.reopenWorkerEnvironmentStore();
    placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const service = await createService();
    const pending = service.get(environmentId);
    if (!pending) {
      throw new Error("forced teardown lost its dedicated environment");
    }
    expect(pending).toMatchObject({
      state: "attached",
      sharedHost: false,
      nodeDeviceId: attached.nodeDeviceId,
      destroyRequestedAtMs: support.testState.nowMs,
      lastError: expect.stringContaining(FORCED_WORKER_ABANDONMENT_ERROR),
      error: expect.stringContaining("provider deletion refused"),
    });
    expect(pending?.lastError).toContain("quota blocked");
    expect(pending?.lastError?.length).toBeLessThanOrEqual(1_024);
    expect(summarizeWorkerEnvironment(pending, support.testState.nowMs)).toMatchObject({
      status: "error",
      worker: {
        error: expect.stringContaining("provider deletion refused"),
      },
    });
    const claimStop = vi.spyOn(placements, "claimReclaimWorkspaceResult");
    const tunnel = vi.spyOn(service, "startTunnel");
    const restarted = await createHarness(support.testState.stateDb, placements, {
      environmentService: service,
      workspacePath: support.testState.root,
    });
    await restarted.service.reconcile("startup");
    // Failed-placement cleanup belongs to the tracked post-start sweep.
    await restarted.service.reconcileActive(environmentId);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(service.get(environmentId)).toMatchObject({
      state: "attached",
      lastError: `${FORCED_WORKER_ABANDONMENT_ERROR}; provider deletion still blocked`,
      error: expect.stringContaining("provider deletion still blocked"),
    });
    await restarted.service.reconcileActive(environmentId);
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(service.get(environmentId)?.state).toBe("destroyed");
    expect(claimStop).not.toHaveBeenCalled();
    expect(tunnel).not.toHaveBeenCalled();
    expect(restarted.log).not.toContain("workspace");
    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      workspaceBaseManifestRef: active.workspaceBaseManifestRef,
      turnClaim: null,
    });
  });

  it.each([false, true])(
    "resumes forced abandonment after a crash between draining and placement failure (destroy already requested: %s)",
    async (alreadyRequested) => {
      const environmentId = "worker-forced-restart";
      await support.seedReady(environmentId);
      const attached = await support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, REQUEST.sessionId),
      });
      let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const active = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      if (alreadyRequested) {
        await support.testState.store.requestDestroy({ environmentId, state: "attached" });
      }
      const destroy = vi.fn(async () => {});
      const createService = async () =>
        support.createService(support.createProvider({ destroy }), {
          placementStore: createWorkerSessionPlacementGate(placements, {
            recoveryPlacements: await placements.listAsync(),
          }),
        });
      const service = await createService();
      const harness = await createHarness(support.testState.stateDb, placements, {
        environmentService: service,
        workspacePath: support.testState.root,
      });
      const crash = new Error("Gateway exits before recording placement failure");
      const reconcile = vi.spyOn(placements, "startReconcile").mockImplementationOnce(() => {
        throw crash;
      });
      await expect(harness.service.forceDestroyEnvironment(environmentId)).rejects.toBe(crash);
      reconcile.mockRestore();
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(await placements.getPlacementMoveAsync(REQUEST.sessionId)).toBeUndefined();
      expect.soft(support.testState.store.get(environmentId)).toMatchObject({
        destroyRequestedAtMs: support.testState.nowMs,
        lastError: FORCED_WORKER_ABANDONMENT_ERROR,
      });
      expect(destroy).not.toHaveBeenCalled();
      const pendingEnvironment = support.testState.store.get(environmentId);
      if (!pendingEnvironment) {
        throw new Error("forced teardown lost its environment");
      }
      await service.recordError(
        pendingEnvironment,
        new Error("transient provider inspection failure"),
      );

      await support.reopenWorkerEnvironmentStore();
      placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const claimStop = vi.spyOn(placements, "claimReclaimWorkspaceResult");
      const restartedService = await createService();
      const tunnel = vi.spyOn(restartedService, "startTunnel");
      const restarted = await createHarness(support.testState.stateDb, placements, {
        environmentService: restartedService,
        workspacePath: support.testState.root,
      });
      await restarted.service.reconcile("startup");

      expect(claimStop).not.toHaveBeenCalled();
      expect(tunnel).not.toHaveBeenCalled();
      expect(restarted.log).not.toContain("workspace");
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "failed",
        turnClaim: null,
        recoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
        workspaceBaseManifestRef: active.workspaceBaseManifestRef,
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(destroy).toHaveBeenCalledOnce();
      expect(restartedService.get(environmentId)?.state).toBe("destroyed");
    },
  );
});
