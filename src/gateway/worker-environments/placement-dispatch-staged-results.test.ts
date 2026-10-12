import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  type PlacementStore,
  REQUEST,
  seedActivePlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { stagePendingWorkerWorkspaceResult } from "./workspace-recovery.test-support.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const it = createCommandTest();

describe("worker placement result recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(() => {
    root = support.testState.root;
    database = support.testState.stateDb;
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  it.for(["failed capture", "crash after drain"] as const)(
    "recovers Stop before releasing the machine after %s and a Gateway restart",
    async (interruption, { command }) => {
      const workspacePath = path.join(root, "restart-stop-workspace");
      const initialized = await command.run("git", ["init", "--quiet", workspacePath], {
        timeout: 10_000,
      });
      expect(initialized.status).toBe(0);
      const original = createHarness(database, placementStore, {
        workspacePath,
        reconcileFailureCount: 1,
      });
      const active = await original.service.dispatch(REQUEST);
      if (interruption === "failed capture") {
        await expect(original.service.reclaim(REQUEST)).rejects.toThrow("workspace conflict");
      } else {
        await placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      }
      expect(placementStore.get(active.sessionId)).toMatchObject({
        state: "draining",
        turnClaim: null,
      });
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);

      await closeStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restarted = createHarness(database, restartedStore, {
        workspacePath,
        reconcileFailureCount: 1,
      });
      restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      await restarted.service.reconcile("startup");

      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      expect(restartedStore.get(active.sessionId)?.state).toBe("draining");
      expect(restarted.reportWorkspaceResultRecoveryFailure).toHaveBeenCalled();
      await restarted.service.reconcileActive();

      expect(restartedStore.get(active.sessionId)).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: restarted.reconciledManifestRef,
      });
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restarted.environments.destroy).toHaveBeenCalledOnce();
      expect(restarted.log.indexOf("workspace:verify-local")).toBeLessThan(
        restarted.log.indexOf("teardown:destroy"),
      );
      console.info("[stop-restart-proof]", interruption, restarted.log.join(","));
    },
  );

  async function seedWorkerTurn(harness: ReturnType<typeof createHarness>) {
    const active = await harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = await placementStore.claimTurn({
      ...REQUEST,
      claimId: "staged-claim",
      runId: "staged-run",
      owner: placementTurnOwner(active),
    });
    return { active, claim };
  }

  it("applies a staged pending result without a tunnel and reclaims the worker", async () => {
    const workspacePath = path.join(root, "same-worker-staged-result");
    const priorConflictRef = "refs/openclaw/worker-results/prior-conflict";
    const prepareAcceptedWorkspacePublication = vi.fn(async () => {
      throw new Error("publication snapshot rejected");
    });
    const publishAcceptedWorkspace = vi.fn(async () => undefined);
    const harness = createHarness(database, placementStore, {
      workspacePath,
      priorWorkspaceResultConflict: { paths: ["old.txt"], stagedResultRef: priorConflictRef },
      prepareAcceptedWorkspacePublication,
      publishAcceptedWorkspace,
    });
    const { active, claim } = await seedWorkerTurn(harness);
    harness.markEnvironmentOwnerEpoch(2);
    const staged = await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "update-ref", priorConflictRef, staged.stagedResultRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).toBe(0);
    await placementStore.handoffWorkspaceResultRecovery(claim);

    await harness.service.reconcile();

    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "worker\n",
    );
    expect(harness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: staged.currentManifestRef,
    });
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(prepareAcceptedWorkspacePublication).toHaveBeenCalledWith(claim);
    expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).not.toBe(0);
    expect(harness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      cleared: true,
    });
    expect(
      (
        await runCommandWithTimeout(
          ["git", "-C", workspacePath, "show-ref", "--verify", priorConflictRef],
          { timeoutMs: 10_000 },
        )
      ).code,
    ).not.toBe(0);
  });

  it.each(["retained", "removed-before-restart"] as const)(
    "keeps an accepted result fenced until provider deletion succeeds (%s ref)",
    async (refState) => {
      const workspacePath = path.join(root, "accepted-result-cleanup");
      const publishAcceptedWorkspace = vi.fn(async () => undefined);
      const fixtureHarness = createHarness(database, placementStore, { workspacePath });
      const fixtureStart = vi
        .mocked(fixtureHarness.environments.startTunnel)
        .getMockImplementation()!;
      const tunnels = createWorkerTunnelManager();
      let claim: Awaited<ReturnType<PlacementStore["claimTurn"]>> | undefined;
      vi.spyOn(tunnels, "start").mockImplementation(async (request) => ({
        ...(await fixtureStart(request)),
        reconcileWorkspace: async ({ source }) => {
          if (source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          const owned = placementStore.get(REQUEST.sessionId);
          if (owned?.state !== "draining" || !owned.turnClaim) {
            throw new Error("reclaim fixture lost its claim");
          }
          claim = {
            sessionId: owned.sessionId,
            claimId: owned.turnClaim.claimId,
            runId: owned.turnClaim.runId,
            placementGeneration: owned.turnClaim.generation,
            owner: placementTurnOwner(owned),
          };
          const staged = await stagePendingWorkerWorkspaceResult({
            store: placementStore,
            claim,
            workspacePath,
            base: "base\n",
            current: "worker\n",
          });
          const applied = await applyStagedWorkerWorkspaceResult({
            root: workspacePath,
            stagedResultRef: staged.stagedResultRef,
            expectedBaseManifestRef: staged.baseManifestRef,
            journal: source.journal,
          });
          return {
            ...applied,
            verifyStable: async () => {},
            publishStagedResult: async () => {},
            discardPreparedStagedResult: async () => {},
            getAppliedWorkspaceResult: () => applied,
          };
        },
      }));
      const destroy = vi.fn(async (): Promise<void> => {
        throw new Error("provider deletion unavailable");
      });
      support.testState.prepareInstallation = async () => ({
        ...support.BUNDLE_ARTIFACT,
        protocolFeatures: [
          WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
          WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
        ],
      });
      const environments = support.createService(support.createProvider({ destroy }), {
        tunnelManager: tunnels,
        placementStore: createWorkerSessionPlacementGate(placementStore),
      });
      const ready = await environments.createWithRequest({
        profileId: "development",
        idempotencyKey: "session-dispatch:session-1:1",
        executionMode: "remote-exec",
      });
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      await seedActivePlacement(placementStore, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        executionMode: "remote-exec",
      });
      fixtureHarness.markEnvironmentOwnerEpoch(attached.ownerEpoch);
      const harness = createHarness(database, placementStore, {
        workspacePath,
        publishAcceptedWorkspace,
        environmentService: environments,
      });

      await expect(harness.service.reclaim(REQUEST)).rejects.toThrow(
        "provider deletion unavailable",
      );
      expect(environments.get(ready.environmentId)).toMatchObject({
        state: "destroying",
        ownerEpoch: attached.ownerEpoch + 1,
        destroyRequestedAtMs: 1_000,
        leaseId: ready.leaseId,
      });
      const [pending] = await placementStore.listPendingWorkspaceResultsAsync();
      expect(pending).toMatchObject({ workspaceAcceptedAtMs: 1_000 });
      if (!pending?.stagedResultRef) {
        throw new Error("reclaim fixture did not retain its staged result");
      }
      let recovery = harness;
      if (refState === "removed-before-restart") {
        expect(
          await runCommandWithTimeout(
            [
              "git",
              "-C",
              workspacePath,
              "update-ref",
              "-d",
              cleanupWorkerWorkspaceResultRef(pending.stagedResultRef),
            ],
            { timeoutMs: 10_000 },
          ),
        ).toMatchObject({ code: 0 });
        const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
        restartedStore.clearLocalTurnClaimsAfterRestart();
        recovery = createHarness(database, restartedStore, {
          workspacePath,
          publishAcceptedWorkspace,
          environmentService: environments,
        });
      }

      destroy.mockClear();
      await recovery.service.reconcileActive(ready.environmentId);
      expect(destroy).toHaveBeenCalledOnce();
      expect(recovery.placements.current()).toMatchObject({
        state: "draining",
        environmentId: ready.environmentId,
        activeOwnerEpoch: attached.ownerEpoch,
        turnClaim:
          refState === "retained"
            ? expect.objectContaining({ claimId: pending.claimId, runId: pending.runId })
            : null,
      });

      await expect(recovery.service.reclaim(REQUEST)).rejects.toThrow(
        refState === "retained"
          ? "cannot stop cloud worker"
          : "Active cloud worker does not match its session placement",
      );
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([pending]);
      destroy.mockClear().mockResolvedValue(undefined);
      await recovery.service.reconcileActive(ready.environmentId);
      expect(destroy).toHaveBeenCalledOnce();
      await expect(recovery.service.reclaim(REQUEST)).resolves.toMatchObject({
        state: "reclaimed",
      });
      expect(environments.get(ready.environmentId)?.state).toBe("destroyed");
      expect(publishAcceptedWorkspace).toHaveBeenCalledWith(claim);
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "worker\n",
      );
    },
  );

  it("does not destroy the worker while a nested session operation is running", async () => {
    const workspacePath = path.join(root, "running-session-operation");
    const harness = createHarness(database, placementStore, { workspacePath });
    const { active, claim } = await seedWorkerTurn(harness);
    harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    await placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    const binding = claim;
    expect(
      await placementStore.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "running-session-operation-call",
        requestDigest: "running-session-operation-digest",
      }),
    ).toMatchObject({ kind: "execute" });
    await placementStore.handoffWorkspaceResultRecovery(claim);
    const { promise: toolAdmissionClosed, resolve: signalToolAdmissionClosed } = createDeferred();
    const closeWorkerTurnToolState = placementStore.closeWorkerTurnToolState.bind(placementStore);
    // Reconciliation performs real Git I/O before reaching this boundary, so
    // synchronize on admission closure instead of a wall-clock polling budget.
    vi.spyOn(placementStore, "closeWorkerTurnToolState").mockImplementation((closingClaim) => {
      const closing = closeWorkerTurnToolState(closingClaim);
      signalToolAdmissionClosed();
      return closing;
    });

    const reconciliation = harness.service.reconcile();

    let completed = false;
    try {
      await Promise.race([
        toolAdmissionClosed,
        reconciliation.then(() => {
          throw new Error("Reconciliation completed before closing tool admission");
        }),
      ]);
      expect(placementStore.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(harness.placements.current()).toMatchObject({
        state: "draining",
        turnClaim: { claimId: claim.claimId },
      });
      expect(await placementStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    } finally {
      // Join recovery even when a fence assertion fails, before database teardown.
      try {
        completed = await placementStore.completeWorkerSessionToolOperation({
          sourceSessionId: claim.sessionId,
          sourceClaimId: claim.claimId,
          toolCallId: "running-session-operation-call",
          requestDigest: "running-session-operation-digest",
          resultJson: '{"status":"ok"}',
        });
      } finally {
        await reconciliation;
      }
    }
    expect(completed).toBe(true);

    expect(harness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it.each([
    "surviving node",
    "same-instance node",
    "dead worker",
    "draining node",
    "destroy-requested node",
  ] as const)(
    "applies a staged result after restart while preserving only its active surviving node: %s",
    async (scenario) => {
      const workspacePath = path.join(root, "dead-worker-staged-result");
      const originalHarness = createHarness(database, placementStore, { workspacePath });
      const { active, claim } = await seedWorkerTurn(originalHarness);
      const staged = await stagePendingWorkerWorkspaceResult({
        store: placementStore,
        claim,
        workspacePath,
        base: "base\n",
        current: "worker\n",
      });
      const sameGatewayInstance = scenario === "same-instance node";
      const preserved = scenario === "surviving node" || sameGatewayInstance;
      const restartedStore = sameGatewayInstance
        ? placementStore
        : createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restartedHarness = createHarness(database, restartedStore, { workspacePath });
      if (sameGatewayInstance) {
        await placementStore.handoffWorkspaceResultRecovery(claim);
      }
      if (scenario === "dead worker") {
        restartedHarness.markEnvironmentDestroyed();
      } else {
        restartedHarness.markEnvironmentNodeDeviceId("surviving-node");
        if (scenario === "draining node") {
          await restartedStore.startWorkspaceResultDrain(claim);
        } else if (scenario === "destroy-requested node") {
          vi.mocked(restartedHarness.environments.get).mockReturnValue({
            ...restartedHarness.attached,
            nodeDeviceId: "surviving-node",
            destroyRequestedAtMs: 2_000,
          });
        }
      }

      await restartedHarness.service.reconcile();

      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "worker\n",
      );
      expect(restartedHarness.placements.current()).toMatchObject({
        state: preserved ? "active" : "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: staged.currentManifestRef,
      });
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
      expect(restartedHarness.log).not.toContain("placement:failed");
      if (preserved) {
        expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
        if (sameGatewayInstance) {
          expect(restartedHarness.environments.stopTunnel).not.toHaveBeenCalled();
        } else {
          expect(restartedHarness.environments.stopTunnel).toHaveBeenCalledOnce();
          expect(restartedHarness.environments.stopTunnel).toHaveBeenCalledWith(
            active.environmentId,
            active.activeOwnerEpoch,
          );
        }
        expect(restartedHarness.placements.current()).toMatchObject({
          environmentId: active.environmentId,
          activeOwnerEpoch: active.activeOwnerEpoch,
          remoteWorkspaceDir: active.remoteWorkspaceDir,
        });
      } else if (scenario !== "dead worker") {
        expect(restartedHarness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
      }
    },
  );

  it.each(["active", "active-node", "draining", "draining-reclaim", "accepted-reclaim"] as const)(
    "recovers a staged remote-exec %s result after restart clears its local claim",
    async (placementState) => {
      const workspacePath = path.join(root, `remote-exec-restart-${placementState}-result`);
      const originalHarness = createHarness(database, placementStore, {
        workspacePath,
        destroyFailureCount: placementState === "accepted-reclaim" ? 1 : 0,
      });
      const active = await originalHarness.placements.seedActive(2, "remote-exec");
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const preservesNode = placementState === "active-node";
      const claimId = preservesNode
        ? "remote-exec-restart-node-turn"
        : `reclaim-remote-exec-restart-${placementState}`;
      const claimInput = {
        ...REQUEST,
        claimId,
        runId: claimId,
        owner: {
          kind: "local" as const,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      };
      const drain = async () => {
        expect(
          await placementStore.startDrain({
            sessionId: active.sessionId,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
            expectedGeneration: active.generation,
          }),
        ).toMatchObject({ state: "draining" });
      };
      if (placementState === "draining-reclaim" || placementState === "accepted-reclaim") {
        await drain();
      }
      const claim =
        placementState === "draining" || preservesNode
          ? await placementStore.claimTurn(claimInput)
          : await placementStore.claimReclaimWorkspaceResult(claimInput);
      if (placementState === "draining") {
        await drain();
      }
      const staged = await stagePendingWorkerWorkspaceResult({
        store: placementStore,
        claim,
        workspacePath,
        base: "base\n",
        current: "remote exec\n",
      });
      if (placementState === "accepted-reclaim") {
        originalHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
        await placementStore.handoffWorkspaceResultRecovery(claim);
        await originalHarness.service.reconcile();
        expect(await placementStore.listPendingWorkspaceResultsAsync()).toMatchObject([
          { workspaceAcceptedAtMs: 1_000, placementGeneration: claim.placementGeneration },
        ]);
        expect(originalHarness.environments.destroy).toHaveBeenCalledOnce();
      }

      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      expect(restartedStore.clearLocalTurnClaimsAfterRestart()).toBe(1);
      expect(restartedStore.get(active.sessionId)).toMatchObject({
        state: placementState === "active" || preservesNode ? "active" : "draining",
        turnClaim: null,
      });
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      await restartedStore.prepareWorkspaceResultClaim(claim);
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(true);
      for (const staleClaim of [
        { ...claim, claimId: `${claim.claimId}-stale` },
        { ...claim, runId: `${claim.runId}-stale` },
        { ...claim, placementGeneration: claim.placementGeneration - 1 },
        { ...claim, placementGeneration: claim.placementGeneration + 1 },
        { ...claim, placementGeneration: claim.placementGeneration + 2 },
        {
          ...claim,
          owner: {
            kind: "worker" as const,
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          },
        },
        {
          ...claim,
          owner: { ...claim.owner, environmentId: `${claim.owner.environmentId}-stale` },
        },
        {
          ...claim,
          owner: { ...claim.owner, ownerEpoch: (claim.owner.ownerEpoch ?? 0) + 1 },
        },
      ]) {
        expect(restartedStore.validateWorkspaceResultClaim(staleClaim)).toBe(false);
        await expect(restartedStore.acceptWorkspaceResult(staleClaim)).rejects.toThrow(
          "Cannot update stale worker workspace result",
        );
      }
      await expect(
        restartedStore.claimReclaimWorkspaceResult({
          ...claimInput,
          claimId: "reclaim-replacement",
          runId: "reclaim-replacement",
        }),
      ).rejects.toThrow("Worker workspace result is already pending");
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(true);
      const restartedHarness = createHarness(database, restartedStore, { workspacePath });
      restartedHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      if (preservesNode) {
        restartedHarness.markEnvironmentNodeDeviceId("surviving-remote-exec-node");
      }
      if (placementState === "accepted-reclaim") {
        restartedHarness.markEnvironmentDestroyed();
        expect(restartedHarness.environments.get(active.environmentId)).toMatchObject({
          state: "destroyed",
          ownerEpoch: active.activeOwnerEpoch + 1,
        });
      }

      await restartedHarness.service.reconcile();

      await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
        "remote exec\n",
      );
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restartedHarness.placements.current()).toMatchObject({
        state: preservesNode ? "active" : "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: staged.currentManifestRef,
      });
      expect(restartedHarness.environments.startTunnel).not.toHaveBeenCalled();
      if (preservesNode) {
        expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
        expect(restartedHarness.environments.stopTunnel).toHaveBeenCalledWith(
          active.environmentId,
          active.activeOwnerEpoch,
        );
        expect(restartedHarness.placements.current()).toMatchObject({
          environmentId: active.environmentId,
          activeOwnerEpoch: active.activeOwnerEpoch,
          remoteWorkspaceDir: active.remoteWorkspaceDir,
        });
      }
      if (placementState === "accepted-reclaim") {
        expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
        expect(
          await runCommandWithTimeout(
            [
              "git",
              "-C",
              workspacePath,
              "show-ref",
              "--verify",
              cleanupWorkerWorkspaceResultRef(staged.stagedResultRef),
            ],
            { timeoutMs: 10_000 },
          ),
        ).not.toMatchObject({ code: 0 });
      }
    },
  );

  it("adopts a published result after a crash before its fence-row update", async () => {
    const workspacePath = path.join(root, "published-unrecorded-result");
    const originalHarness = createHarness(database, placementStore, { workspacePath });
    const { claim } = await seedWorkerTurn(originalHarness);
    const staged = await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
      record: false,
    });
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(database, restartedStore, { workspacePath });
    restartedHarness.markEnvironmentDestroyed();

    await restartedHarness.service.reconcile();

    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "worker\n",
    );
    expect(restartedHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: staged.currentManifestRef,
    });
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("resolves a diverged staged fence and retains its inspectable cloud ref", async () => {
    const workspacePath = path.join(root, "diverged-staged-result");
    const originalHarness = createHarness(database, placementStore, { workspacePath });
    const { active, claim } = await seedWorkerTurn(originalHarness);
    const staged = await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "local divergence\n");
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restartedHarness = createHarness(database, restartedStore, { workspacePath });
    restartedHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
    const secret = [
      String.fromCharCode(115, 107),
      "proj",
      "recovery",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    const failure = new Error(
      `transcript report interrupted token=${secret} ${"detail ".repeat(200)}`,
    );
    restartedHarness.reportWorkspaceResultConflict
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    restartedHarness.reportWorkspaceResultRecoveryFailure.mockRejectedValueOnce(
      new Error("recovery transcript temporarily unavailable"),
    );

    await restartedHarness.service.reconcile();

    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { stagedResultRef: staged.stagedResultRef, workspaceAcceptedAtMs: 2_000 },
    ]);
    expect(restartedStore.get(active.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId, runId: claim.runId },
    });
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
    expect(restartedHarness.reportWorkspaceResultRecoveryFailure).toHaveBeenCalledOnce();
    const recovery = restartedHarness.reportWorkspaceResultRecoveryFailure.mock.calls[0]?.[0];
    expect(recovery).toMatchObject({
      sessionId: active.sessionId,
      sessionKey: active.sessionKey,
      agentId: active.agentId,
      error: expect.stringContaining("transcript report interrupted"),
    });
    expect(JSON.stringify(recovery)).not.toContain(secret);
    expect(recovery?.error.length).toBeLessThanOrEqual(1_024);

    await restartedHarness.service.reconcile();

    expect(restartedHarness.reportWorkspaceResultRecoveryFailure).toHaveBeenCalledTimes(2);
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    expect(restartedHarness.environments.destroy).not.toHaveBeenCalled();
    expect(
      await runCommandWithTimeout(
        ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "later local edit\n");
    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(database, finalStore, { workspacePath });
    finalHarness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);

    await finalHarness.service.reconcile();

    const recovered = finalHarness.placements.current();
    expect(recovered).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceResultConflict: {
        paths: ["result.txt"],
        stagedResultRef: staged.stagedResultRef,
      },
    });
    expect(recovered?.workspaceBaseManifestRef).not.toBe(staged.currentManifestRef);
    expect(await finalStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(finalHarness.environments.startTunnel).not.toHaveBeenCalled();
    expect(finalHarness.environments.destroy).toHaveBeenCalledWith(active.environmentId);
    expect(finalHarness.reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
    expect(finalHarness.log).not.toContain("placement:failed");
    expect(finalHarness.reportWorkspaceResultConflict).toHaveBeenCalledWith({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      paths: ["result.txt"],
      stagedResultRef: staged.stagedResultRef,
      totalCount: 1,
    });
    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "later local edit\n",
    );
    expect(
      await runCommandWithTimeout(
        ["git", "-C", workspacePath, "show-ref", "--verify", staged.stagedResultRef],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
  });

  it("reports a post-accept revert to the original base as a conflict", async () => {
    const workspacePath = path.join(root, "accepted-clean-local-advance");
    const originalHarness = createHarness(database, placementStore, { workspacePath });
    const { claim } = await seedWorkerTurn(originalHarness);
    const staged = await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      base: "base\n",
      current: "worker\n",
    });
    const acceptingStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const acceptingHarness = createHarness(database, acceptingStore, { workspacePath });
    acceptingHarness.markEnvironmentDestroyed();
    vi.spyOn(acceptingStore, "completeWorkspaceResultAndReleaseTurn").mockImplementationOnce(() => {
      throw new Error("release interrupted");
    });

    await acceptingHarness.service.reconcile();

    expect(await acceptingStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { workspaceAcceptedAtMs: 2_000 },
    ]);
    await fs.writeFile(path.join(workspacePath, "result.txt"), "base\n");
    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(database, finalStore, { workspacePath });
    finalHarness.markEnvironmentDestroyed();

    await finalHarness.service.reconcile();

    expect(finalHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceResultConflict: {
        paths: ["result.txt"],
        stagedResultRef: staged.stagedResultRef,
      },
    });
    await expect(fs.readFile(path.join(workspacePath, "result.txt"), "utf8")).resolves.toBe(
      "base\n",
    );
    expect(await finalStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("does not replay an unchanged-hash conflicted apply after a crash", async () => {
    const workspacePath = path.join(root, "unchanged-hash-conflict");
    const originalHarness = createHarness(database, placementStore, { workspacePath });
    const { active, claim } = await seedWorkerTurn(originalHarness);
    await stagePendingWorkerWorkspaceResult({
      store: placementStore,
      claim,
      workspacePath,
      current: "worker\n",
    });
    const baseManifestRef = placementStore.get(active.sessionId)?.workspaceBaseManifestRef;
    expect(
      (
        await runCommandWithTimeout(["mkfifo", path.join(workspacePath, "result.txt")], {
          timeoutMs: 10_000,
        })
      ).code,
    ).toBe(0);

    const interruptedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const interruptedHarness = createHarness(database, interruptedStore, { workspacePath });
    interruptedHarness.markEnvironmentDestroyed();
    vi.spyOn(interruptedStore, "acceptWorkspaceResult").mockImplementationOnce(() => {
      throw new Error("acceptance interrupted");
    });
    await interruptedHarness.service.reconcile();

    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    expect(await interruptedStore.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef: baseManifestRef,
    });
    await fs.rm(path.join(workspacePath, "result.txt"));

    const finalStore = createWorkerSessionPlacementStore({ database, now: () => 3_000 });
    const finalHarness = createHarness(database, finalStore, { workspacePath });
    finalHarness.markEnvironmentDestroyed();
    await finalHarness.service.reconcile();

    await expect(fs.stat(path.join(workspacePath, "result.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(finalHarness.placements.current()).toMatchObject({
      state: "reclaimed",
      workspaceResultConflict: { paths: ["result.txt"] },
    });
    expect(await finalStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  });
});
