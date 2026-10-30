import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
  type WorkerAdmissionHandshake,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness, createRecoveryService } from "./placement-dispatch-test-harness.js";
import {
  expectPlacement,
  makeClaimInput,
  WORKER_PROTOCOL_FEATURES,
} from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile-apply.js";
import {
  gitInit,
  manifestFor,
  stagePendingWorkerWorkspaceResult,
} from "./workspace-recovery.test-support.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

function createPlacementStore() {
  return createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => 1_000,
  });
}

describe("worker placement restart recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("cancels an unfinished provisioning request instead of resuming it", async () => {
    const placements = createPlacementStore();
    const harness = await createHarness(support.testState.stateDb, placements);
    const provisioning = await harness.placements.seedProvisioning();

    await harness.service.reconcile("startup");

    expectPlacement(placements, "failed", {
      environmentId: provisioning.environmentId,
      recoveryError: "Cloud worker provisioning canceled by Gateway restart",
    });
    expect(harness.environments.destroy).toHaveBeenCalledWith(provisioning.environmentId);
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "saves an interrupted worker's files before releasing its claim (disconnected: %s)",
    async (disconnected) => {
      const workspacePath = path.join(support.testState.root, "gateway-workspace");
      const workerPath = path.join(support.testState.root, "worker-workspace");
      await fs.mkdir(workspacePath);
      await fs.mkdir(workerPath);
      await gitInit(workspacePath);
      await fs.writeFile(path.join(workspacePath, "result.txt"), "base\n");
      await fs.writeFile(path.join(workerPath, "result.txt"), "unfinished worker edit\n");
      const base = await manifestFor(workspacePath);
      const placements = createPlacementStore();
      const original = await createHarness(support.testState.stateDb, placements);
      const active = await original.placements.seedActive(2);
      assert(active.state === "active");
      const claim = await placements.claimTurn(makeClaimInput(active, "interrupted-worker"));
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);

      const restartedStore = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => 2_000,
      });
      const restarted = await createHarness(support.testState.stateDb, restartedStore, {
        workspacePath,
      });
      restarted.markEnvironmentNodeDeviceId("interrupted-worker-node");
      const tunnel = restarted.tunnelHandle(active.activeOwnerEpoch);
      const launchTurn = vi.spyOn(tunnel, "launchTurn");
      vi.mocked(tunnel.reconcileWorkspace).mockImplementation(
        async ({ source, baseManifestRef }) => {
          assert(source.kind === "local");
          expect(restarted.log).toContain("teardown:stop");
          expect(restarted.log.indexOf("teardown:stop")).toBeLessThan(
            restarted.log.indexOf("workspace:quiesce"),
          );
          const current = await manifestFor(workerPath);
          const applied = await applyStagedWorkerWorkspace({
            root: source.path,
            stagingRoot: workerPath,
            baseManifestRef,
            currentManifestRef: `sha256:${createHash("sha256").update(JSON.stringify(current)).digest("hex")}`,
            base,
            current,
            journal: source.journal,
            assertCurrent: source.assertCurrent,
            acceptance: { kind: "reconcile" },
          });
          return {
            ...applied,
            changed: true,
            verifyStable: async () => {},
            publishStagedResult: async () => {},
            discardPreparedStagedResult: async () => {},
            getAppliedWorkspaceResult: () => applied,
          };
        },
      );
      vi.mocked(restarted.environments.startTunnel).mockResolvedValue(tunnel);
      if (disconnected) {
        vi.mocked(restarted.environments.startTunnel).mockRejectedValueOnce(
          new WorkerTunnelOwnerDisconnectedError(),
        );
      }

      await restarted.service.reconcile("startup");

      if (disconnected) {
        expectPlacement(restartedStore, "active", { turnClaim: { claimId: claim.claimId } });
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        expect(restarted.environments.destroy).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
          "base\n",
        );
        await restarted.service.reconcileActive();
      }
      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "unfinished worker edit\n",
      );
      expectPlacement(restartedStore, "active", { turnClaim: null });
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      expect(launchTurn).not.toHaveBeenCalled();
    },
  );

  describe.each(["startup", "active"] as const)("%s recovery after worker retirement", (mode) => {
    it.each(["idle", "claimed turn", "pending result", "provider loss"] as const)(
      "reclaims only a clean idle stale-build placement: %s",
      async (scenario) => {
        const placements = createPlacementStore();
        const harness = await createHarness(support.testState.stateDb, placements, {
          workspacePath: support.testState.root,
        });
        const active = await harness.placements.seedActive(harness.attached.ownerEpoch);
        assert(active.state === "active", "retirement fixture did not produce an active placement");
        const error =
          scenario === "provider loss" ? "provider lost worker" : STALE_WORKER_BUILD_REASON;
        vi.mocked(harness.environments.get).mockReturnValue({
          ...harness.attached,
          state: "failed",
          leaseId: null,
          sshEndpoint: null,
          bootstrapReceipt: null,
          sharedHost: null,
          tunnelStatus: "stopped",
          lastError: error,
          error,
        });
        if (scenario === "claimed turn" || scenario === "pending result") {
          const claim = await placements.claimTurn(
            makeClaimInput(active, "retirement-claim", "retirement-run"),
          );
          if (scenario === "pending result") {
            await placements.markWorkspaceResultPending(claim);
            await placements.handoffWorkspaceResultRecovery(claim);
          }
        }

        if (mode === "startup") {
          await harness.service.reconcile("startup");
        } else {
          await harness.service.reconcileActive();
        }

        if (scenario === "idle") {
          expectPlacement(placements, "reclaimed", {
            terminalReason: null,
            recoveryError: null,
            turnClaim: null,
          });
          expect(harness.environments.destroy).not.toHaveBeenCalled();
        } else {
          const expectedError =
            scenario === "claimed turn" && mode === "startup"
              ? "Active worker turn claim cannot be proven live after gateway restart"
              : `cloud worker disappeared: ${error}`;
          expectPlacement(placements, "failed", {
            terminalReason: expectedError,
            recoveryError: expectedError,
            turnClaim: null,
          });
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      },
    );
  });

  it.each(["startup", "active"] as const)(
    "does not report successful reclaim while provider-loss teardown is pending during %s recovery",
    async (mode) => {
      support.testState.prepareInstallation = vi.fn(async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      }));
      const destroy = vi.fn(async (): Promise<void> => {
        throw new Error("provider deletion unavailable");
      });
      const environments = support.createService(
        support.createProvider({ inspect: async () => ({ status: "unknown" }), destroy }),
      );
      const ready = await environments.createWithRequest({
        profileId: "development",
        idempotencyKey: "provider-loss-cleanup",
        executionMode: "remote-exec",
      });
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      await seedActivePlacement(placements, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      const recovery = await createRecoveryService(placements, environments);

      if (mode === "startup") {
        await recovery.reconcile("startup");
      } else {
        await recovery.reconcileActive(ready.environmentId);
      }

      expect.soft(destroy).toHaveBeenCalledOnce();
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "destroying",
        leaseId: ready.leaseId,
        destroyRequestedAtMs: support.testState.nowMs,
      });
      destroy.mockClear();
      await recovery.reconcileActive(ready.environmentId);
      expect.soft(destroy).toHaveBeenCalledOnce();

      destroy.mockClear();
      await expect(recovery.reclaim(REQUEST)).rejects.toThrow("provider deletion unavailable");
      expect(destroy).toHaveBeenCalledOnce();
      expectPlacement(placements, "failed", {
        environmentId: ready.environmentId,
        recoveryError: expect.stringContaining("teardown failed"),
      });

      destroy.mockClear().mockResolvedValue(undefined);
      await expect(recovery.reclaim(REQUEST)).resolves.toMatchObject({ state: "local" });
      expect(destroy).toHaveBeenCalledOnce();
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
      });
    },
  );

  it.each(["startup", "active"] as const)(
    "fences a destroy-requested attachment during %s recovery even when physical cleanup fails",
    async (mode) => {
      const placements = createPlacementStore();
      const harness = await createHarness(support.testState.stateDb, placements, {
        destroyFails: true,
      });
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        nodeDeviceId: "revoked-node",
        destroyRequestedAtMs: 1_000,
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      vi.mocked(harness.environments.stopTunnel).mockRejectedValue(
        new Error("node role revoked before stop confirmation"),
      );
      await harness.placements.seedActive(environment.ownerEpoch);

      if (mode === "startup") {
        await harness.service.reconcile("startup");
      } else {
        await harness.service.reconcileActive(environment.environmentId);
      }

      expectPlacement(placements, "failed", {
        environmentId: environment.environmentId,
        activeOwnerEpoch: environment.ownerEpoch,
        recoveryError: expect.stringContaining("node role revoked before stop confirmation"),
      });
      expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
      expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    },
  );

  it.each<{
    name: string;
    executionMode?: "remote-exec" | "worker-turn";
    snapshotMode?: "remote-exec" | "worker-turn";
    nodeBacked?: boolean;
    supported?: boolean;
    sweep?: boolean;
    error?: string;
  }>([
    { name: "unsupported provider", supported: false, error: "does not support remote-exec" },
    {
      name: "mismatched mode",
      snapshotMode: "worker-turn",
      error: "execution mode does not match",
    },
    {
      name: "SSH worker-turn",
      executionMode: "worker-turn",
      nodeBacked: false,
      error: "requires a node lease",
    },
    {
      name: "runtime provider change",
      supported: false,
      sweep: true,
      error: "does not support remote-exec",
    },
    { name: "adopts node lease" },
    { name: "adopts SSH lease", nodeBacked: false },
  ])(
    "recovers active durable-provider placement: $name",
    async ({
      executionMode = "remote-exec",
      snapshotMode = executionMode,
      nodeBacked = true,
      supported = true,
      sweep = false,
      error,
    }) => {
      const placements = createPlacementStore();
      const harness = await createHarness(support.testState.stateDb, placements);
      await harness.environments.attachSession({
        environmentId: harness.ready.environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const environment = {
        ...harness.attached,
        providerId: "durable-provider",
        profileSnapshot: { ...harness.attached.profileSnapshot, executionMode: snapshotMode },
        ...(nodeBacked ? { nodeDeviceId: "durable-node", sshEndpoint: null } : {}),
      };
      vi.mocked(harness.environments.get).mockReturnValue(environment);
      const supports = vi.mocked(harness.environments.supportsProviderExecutionMode);
      if (error) {
        supports.mockReturnValue(supported);
      }
      await harness.placements.seedActive(environment.ownerEpoch, executionMode);
      if (sweep) {
        await harness.service.reconcileActive(environment.environmentId);
      } else {
        await harness.service.reconcile();
      }
      if (error) {
        expectPlacement(placements, "failed", { recoveryError: expect.stringContaining(error) });
        expect(harness.environments.startTunnel).not.toHaveBeenCalled();
        expect(harness.environments.destroy).toHaveBeenCalledWith(environment.environmentId);
        expect(harness.log).not.toContain("placement:adopted");
      } else {
        expectPlacement(placements, "active", { executionMode });
        expect(supports).toHaveBeenCalledWith("durable-provider", "remote-exec");
        expect(harness.environments.destroy).not.toHaveBeenCalled();
        if (nodeBacked) {
          expect(harness.environments.startTunnel).not.toHaveBeenCalled();
        } else {
          expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it.each([
    { creation: "profile", matchingEnvironmentExists: true },
    { creation: "inherited", matchingEnvironmentExists: true },
    { creation: "profile", matchingEnvironmentExists: false },
  ] as const)(
    "never tears down an unrelated environment returned by $creation creation (expected owner exists: $matchingEnvironmentExists)",
    async ({ creation, matchingEnvironmentExists }) => {
      const placements = createPlacementStore();
      const harness = await createHarness(support.testState.stateDb, placements);
      const unrelatedEnvironment = {
        ...harness.attached,
        environmentId: "worker-unrelated-active",
        ownerEpoch: 91,
        attachedSessionIds: ["session-unrelated"],
      };
      vi.mocked(harness.environments.createWithRequest).mockResolvedValue(unrelatedEnvironment);
      vi.mocked(harness.environments.get).mockImplementation((environmentId) => {
        if (environmentId === unrelatedEnvironment.environmentId) {
          return unrelatedEnvironment;
        }
        return matchingEnvironmentExists && environmentId === harness.ready.environmentId
          ? harness.ready
          : undefined;
      });
      const request =
        creation === "inherited"
          ? {
              ...REQUEST,
              inheritedProfile: {
                providerId: "fake",
                profileSnapshot: { install: "bundle" as const, settings: { region: "parent" } },
              },
            }
          : REQUEST;

      await expect(harness.service.dispatch(request)).rejects.toThrow(
        "current worker launch contract",
      );

      expectPlacement(placements, "failed", { environmentId: harness.ready.environmentId });
      expect(harness.environments.attachSession).not.toHaveBeenCalled();
      expect(harness.environments.stopTunnel).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
        expect.anything(),
      );
      expect(harness.environments.destroy).not.toHaveBeenCalledWith(
        unrelatedEnvironment.environmentId,
      );
      if (matchingEnvironmentExists) {
        expect(harness.environments.stopTunnel).toHaveBeenCalledWith(
          harness.ready.environmentId,
          harness.ready.ownerEpoch,
        );
        expect(harness.environments.destroy).toHaveBeenCalledWith(harness.ready.environmentId);
      } else {
        expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
        expect(harness.environments.destroy).not.toHaveBeenCalled();
      }
    },
  );

  it("fails a placement interrupted before its environment intent and permits redispatch", async () => {
    const placements = createPlacementStore();
    const harness = await createHarness(support.testState.stateDb, placements);
    const provisioning = await harness.placements.seedProvisioning();
    vi.mocked(harness.environments.get).mockReturnValue(undefined);

    await harness.service.reconcile();

    const failed = harness.placements.current();
    expect(failed).toMatchObject({
      state: "failed",
      environmentId: provisioning.environmentId,
      recoveryError: "Cloud worker provisioning canceled by Gateway restart",
    });
    expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    if (failed?.state !== "failed") {
      throw new Error("restart recovery did not fail the interrupted provisioning placement");
    }

    const redispatch = await createHarness(support.testState.stateDb, placements, {
      environmentGeneration: failed.generation + 1,
    });
    const active = await redispatch.service.dispatch(REQUEST);

    expect(active).toMatchObject({
      state: "active",
      environmentId: redispatch.ready.environmentId,
    });
    expect(active.environmentId).not.toBe(provisioning.environmentId);
  });

  it("keeps file custody when an old launch dialect cannot reconnect for cleanup", async () => {
    const placements = createPlacementStore();
    const originalHarness = await createHarness(support.testState.stateDb, placements);
    const active = await originalHarness.placements.seedActive(2);
    assert(active.state === "active", "active placement fixture was not active");
    const claim = await placements.claimTurn(
      makeClaimInput(active, "legacy-worker-claim", "legacy-worker-run"),
    );
    await placements.markWorkspaceResultPending(claim);

    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 2_000,
    });
    const restartedHarness = await createHarness(support.testState.stateDb, restartedStore);
    restartedHarness.markEnvironmentNodeDeviceId("legacy-worker-node");
    restartedHarness.markEnvironmentProtocolFeatures([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]);
    vi.mocked(restartedHarness.environments.startTunnel).mockRejectedValue(
      new WorkerTunnelOwnerDisconnectedError(),
    );

    await restartedHarness.service.reconcile();

    expectPlacement(restartedStore, "active", {
      turnClaim: { claimId: claim.claimId },
    });
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
  });

  it("does not adopt an active worker missing exec-authority launch support", async () => {
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => 1_000,
    });
    const harness = await createHarness(support.testState.stateDb, placements);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: "session-1",
    });
    await harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentProtocolFeatures([WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE]);

    await harness.service.reconcile();

    expectPlacement(placements, "reclaimed");
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it.each(["bundle", "provider"] as const)(
    "keeps stale pending recovery fenced when %s recovery is unavailable",
    async (failure) => {
      const currentReceipt: WorkerAdmissionHandshake = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      };
      let currentBundle: WorkerInstallationArtifact = {
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: currentReceipt.protocolFeatures,
      };
      const recoveryState = { started: false };
      support.testState.prepareInstallation = vi.fn(async (install) => {
        if (install === "bundle" && recoveryState.started && failure === "bundle") {
          throw new Error("bundle unavailable");
        }
        return install === "bundle" ? currentBundle : support.NPM_ARTIFACT;
      });
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const provider = support.createProvider({
        inspect: async () => {
          if (recoveryState.started && failure === "provider") {
            throw new Error("provider unavailable");
          }
          return { status: "active" };
        },
      });
      const workerService = support.createService(provider, { tunnelManager });
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const recovery = await createRecoveryService(placements, workerService);
      const environmentId = "worker-stale-recovery";
      const bootstrapping = await support.seedBootstrapping(environmentId);
      await support.testState.store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: support.readyPatch(environmentId, currentReceipt),
      });
      const attached = await workerService.attachSession({
        environmentId,
        ownerEpoch: 1,
        sessionId: "session-1",
      });
      const active = await seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      assert(active.state === "active", "active placement fixture was not active");
      const claim = await placements.claimTurn(
        makeClaimInput(active, "claim-stale-recovery", "run-stale-recovery"),
      );
      await placements.markWorkspaceResultPending(claim);
      await placements.handoffWorkspaceResultRecovery(claim);
      currentBundle = { ...support.BUNDLE_ARTIFACT, bundleHash: "c".repeat(64) };
      recoveryState.started = true;

      await recovery.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      expect(workerService.get(active.environmentId)).toMatchObject({
        state: "attached",
        destroyRequestedAtMs: null,
      });
      expect(tunnelManager.start).not.toHaveBeenCalled();
    },
  );
  it.each([
    { reclaim: false, restart: true },
    { reclaim: true, restart: true },
    { reclaim: false, restart: false },
  ])(
    "recovers an accepted unstaged result without its node (reclaim=$reclaim, restart=$restart)",
    async ({ reclaim, restart }) => {
      const root = support.testState.root;
      let database = support.testState.stateDb;
      const placementStore = createPlacementStore();
      const workspacePath = path.join(root, "accepted-unchanged-result");
      const priorConflictRef = workerWorkspaceResultRef("prior-conflict");
      const priorConflict = { paths: ["result.txt"], stagedResultRef: priorConflictRef };
      const original = await createHarness(database, placementStore, { workspacePath });
      const active = await original.placements.seedActive(2);
      assert(active.state === "active", "expected an active placement");
      if (reclaim) {
        await placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      }
      const claimInput = makeClaimInput(active, reclaim ? "reclaim-unchanged" : "unchanged-turn");
      const claim = reclaim
        ? await placementStore.claimReclaimWorkspaceResult(claimInput)
        : await placementStore.claimTurn(claimInput);
      await placementStore.markWorkspaceResultPending(claim);
      const prior = await stagePendingWorkerWorkspaceResult({
        store: placementStore,
        claim,
        workspacePath,
        base: "base\n",
        current: "prior worker conflict\n",
        record: false,
        stagedResultRef: priorConflictRef,
      });
      // Crash after unchanged acceptance, before conflict settlement or source teardown.
      await placementStore.updateWorkspaceBaseManifest({
        claim,
        manifestRef: prior.baseManifestRef,
      });
      await placementStore.acceptWorkspaceResult(claim);
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
        { stagedResultRef: null, workspaceAcceptedAtMs: 1_000 },
      ]);
      await fs.writeFile(path.join(workspacePath, "result.txt"), "later local edit\n");
      if (restart) {
        await closeStateDatabaseForTest();
        database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      } else {
        await placementStore.handoffWorkspaceResultRecovery(claim);
      }
      const restartedStore = restart
        ? createWorkerSessionPlacementStore({ database, now: () => 2_000 })
        : placementStore;
      const recovered = await createHarness(database, restartedStore, {
        workspacePath,
        priorWorkspaceResultConflict: priorConflict,
      });
      if (restart) {
        recovered.markEnvironmentDestroyed();
      } else {
        recovered.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      }
      vi.mocked(recovered.environments.startTunnel).mockRejectedValue(
        new Error("node unavailable"),
      );

      await recovered.service.reconcile(restart ? "startup" : undefined);

      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expectPlacement(restartedStore, "reclaimed", { turnClaim: null });
      expect(recovered.environments.startTunnel).not.toHaveBeenCalled();
      expect(recovered.reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).toBe(
        "later local edit\n",
      );
      expect(
        await hasWorkerWorkspaceResultRef({
          root: workspacePath,
          stagedResultRef: priorConflictRef,
        }),
      ).toBe(reclaim);
      if (reclaim) {
        expect(recovered.reportWorkspaceResultConflict).not.toHaveBeenCalled();
      } else {
        expect(recovered.reportWorkspaceResultConflict).toHaveBeenCalledWith({
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          cleared: true,
        });
      }
    },
  );
});
