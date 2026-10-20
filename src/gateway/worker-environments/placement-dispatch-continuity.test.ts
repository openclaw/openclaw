import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("worker placement restart continuity", () => {
  support.setupWorkerEnvironmentServiceSuite();
  async function restartWithClaim(pending: boolean) {
    const database = support.testState.stateDb;
    const options = { workspacePath: path.join(support.testState.root, "workspace") };
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const original = await createHarness(database, store, options);
    const active = await original.placements.seedActive(pending ? 2 : original.attached.ownerEpoch);
    if (active.state !== "active") {
      throw new Error("active placement fixture was not active");
    }
    const claim = await store.claimTurn({
      ...REQUEST,
      claimId: pending ? "surviving-node-claim" : "claim-1",
      runId: pending ? "surviving-node-run" : "run-1",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    if (pending) {
      await store.markWorkspaceResultPending(claim);
    } else {
      await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    }
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = await createHarness(database, restartedStore, options);
    return { active, claim, restartedStore, restarted };
  }

  it.each(["stopped", "stop failed", "owner changed"] as const)(
    "recovers a previous-instance pending result on its surviving node only after the old runtime is stopped: %s",
    async (outcome) => {
      const { active, claim, restartedStore, restarted } = await restartWithClaim(true);
      restarted.markEnvironmentNodeDeviceId("surviving-node");
      vi.mocked(restarted.environments.stopTunnel).mockImplementation(async () => {
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
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
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(restarted.placements.current()?.workspaceBaseManifestRef).toBe(
          restarted.reconciledManifestRef,
        );
        expect(restarted.log).toContain("workspace:resume");
        expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      } else {
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["SSH", "node", "node stop failed"] as const)(
    "fences an interrupted worker turn after restart while preserving its surviving node: %s",
    async (scenario) => {
      const { active, claim, restartedStore, restarted } = await restartWithClaim(false);
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

      if (scenario === "SSH") {
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
        expect(restarted.placements.current()).toMatchObject({
          state: "failed",
          turnClaim: null,
          recoveryError: "Active worker turn claim cannot be proven live after gateway restart",
        });
        expect(restarted.environments.destroy).toHaveBeenCalledWith(active.environmentId);
        return;
      }
      if (scenario === "node stop failed") {
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
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
        workspaceBaseManifestRef: restarted.reconciledManifestRef,
        turnClaim: null,
      });
      expect(restartedStore.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restarted.environments.stopTunnel).toHaveBeenCalledWith(
        active.environmentId,
        active.activeOwnerEpoch,
      );
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      const replacement = await restartedStore.claimTurn({
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
