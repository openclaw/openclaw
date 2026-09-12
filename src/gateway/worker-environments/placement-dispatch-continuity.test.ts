import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("worker placement restart continuity", () => {
  support.setupWorkerEnvironmentServiceSuite();
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;
  const createTestHarness = (
    options: Parameters<typeof createHarness>[2] = {},
    store: PlacementStore = placementStore,
  ) =>
    createHarness(database, store, {
      workspacePath: path.join(support.testState.root, "workspace"),
      ...options,
    });

  beforeEach(() => {
    database = support.testState.stateDb;
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  it.each(["stopped", "stop failed", "owner changed"] as const)(
    "recovers a previous-instance pending result on its surviving node only after the old runtime is stopped: %s",
    async (outcome) => {
      const originalHarness = createTestHarness();
      const active = originalHarness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = placementStore.claimTurn({
        ...REQUEST,
        claimId: "surviving-node-claim",
        runId: "surviving-node-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placementStore.markWorkspaceResultPending(claim);
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restarted = createTestHarness({}, restartedStore);
      restarted.markEnvironmentNodeDeviceId("surviving-node");
      vi.mocked(restarted.environments.stopTunnel).mockImplementation(async () => {
        expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
        if (outcome === "stop failed") {
          throw new Error("worker has not confirmed stop");
        }
        if (outcome === "owner changed") {
          restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch + 1);
        }
      });

      await restarted.service.reconcile();

      expect(restarted.environments.stopTunnel).toHaveBeenCalledWith(
        active.environmentId,
        active.activeOwnerEpoch,
      );
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      expect(restarted.placements.current()).toMatchObject({
        state: "active",
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        remoteWorkspaceDir: active.remoteWorkspaceDir,
        turnClaim: outcome === "stopped" ? null : { claimId: claim.claimId },
      });
      if (outcome === "stopped") {
        expect(restartedStore.listPendingWorkspaceResults()).toEqual([]);
        expect(restarted.placements.current()?.workspaceBaseManifestRef).toBe(
          restarted.reconciledManifestRef,
        );
        expect(restarted.log).toContain("workspace:resume");
        expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      } else {
        expect(restartedStore.listPendingWorkspaceResults()).toHaveLength(1);
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["SSH", "node", "node stop failed"] as const)(
    "fences an interrupted worker turn after restart while preserving its surviving node: %s",
    async (scenario) => {
      const original = createTestHarness();
      const active = original.placements.seedActive(original.attached.ownerEpoch);
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = placementStore.claimTurn({
        ...REQUEST,
        claimId: "claim-1",
        runId: "run-1",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placementStore.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restarted = createTestHarness({}, restartedStore);
      restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      if (scenario !== "SSH") {
        restarted.markEnvironmentNodeDeviceId("surviving-node");
      }
      if (scenario === "node stop failed") {
        vi.mocked(restarted.environments.stopTunnel).mockRejectedValueOnce(
          new Error("worker has not confirmed stop"),
        );
      }

      await restarted.service.reconcile();

      expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
      if (scenario === "SSH") {
        expect(restarted.placements.current()).toMatchObject({
          state: "failed",
          turnClaim: null,
          recoveryError: "Active worker turn claim cannot be proven live after gateway restart",
        });
        expect(restarted.environments.destroy).toHaveBeenCalledWith(active.environmentId);
        return;
      }
      if (scenario === "node stop failed") {
        expect(restarted.placements.current()).toMatchObject({
          state: "active",
          turnClaim: { claimId: claim.claimId },
        });
        expect(restarted.environments.destroy).not.toHaveBeenCalled();
        await restarted.service.reconcileActive();
      }
      expect(restarted.placements.current()).toMatchObject({
        state: "active",
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        remoteWorkspaceDir: active.remoteWorkspaceDir,
        workspaceBaseManifestRef: active.workspaceBaseManifestRef,
        turnClaim: null,
      });
      expect(restartedStore.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restarted.environments.stopTunnel).toHaveBeenCalledWith(
        active.environmentId,
        active.activeOwnerEpoch,
      );
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      const replacement = restartedStore.claimTurn({
        ...REQUEST,
        claimId: "replacement-claim",
        runId: "replacement-run",
        owner: claim.owner,
      });
      await restarted.service.reconcileActive();
      expect(restartedStore.validateTurnClaim(replacement)).toBe(true);
    },
  );
});
