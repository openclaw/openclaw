import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim } from "./placement-suite.test-support.js";
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
    const claim = await store.claimTurn(
      placementClaim(active, pending ? "surviving-node" : "interrupted"),
    );
    if (pending) {
      await store.markWorkspaceResultPending(claim);
    } else {
      await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    }
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
    const restarted = await createHarness(database, restartedStore, options);
    return { active, claim, restartedStore, restarted };
  }

  it.each([
    [true, "stopped"],
    [true, "stop failed"],
    [true, "owner changed"],
    [false, "SSH"],
    [false, "stopped"],
    [false, "stop failed"],
  ] as const)(
    "recovers restart custody after %s pending-result state and %s stop outcome",
    async (pending, outcome) => {
      const { active, claim, restartedStore, restarted } = await restartWithClaim(pending);
      if (!pending) {
        restarted.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      }
      if (outcome !== "SSH") {
        restarted.markEnvironmentNodeDeviceId("surviving-node");
      }
      if (pending) {
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
      } else if (outcome === "stop failed") {
        vi.mocked(restarted.environments.stopTunnel).mockRejectedValueOnce(
          new Error("worker has not confirmed stop"),
        );
      }
      await restarted.service.reconcile();
      if (outcome === "SSH") {
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
        expect(restarted.placements.current()).toMatchObject({
          state: "failed",
          turnClaim: null,
          recoveryError: "Active worker turn claim cannot be proven live after gateway restart",
        });
        expect(restarted.environments.destroy).toHaveBeenCalledWith(active.environmentId);
        return;
      }
      expect(restarted.environments.stopTunnel).toHaveBeenCalledWith(
        active.environmentId,
        active.activeOwnerEpoch,
      );
      const identity = {
        state: "active",
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        remoteWorkspaceDir: active.remoteWorkspaceDir,
      };
      if (outcome !== "stopped") {
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
        expect(restarted.placements.current()).toMatchObject({
          ...identity,
          turnClaim: { claimId: claim.claimId },
        });
        if (pending) {
          expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
          return;
        }
        await restarted.service.reconcileActive();
      }
      expect(restarted.placements.current()).toMatchObject({
        ...identity,
        workspaceBaseManifestRef: restarted.reconciledManifestRef,
        turnClaim: null,
      });
      expect(restartedStore.validateTurnClaim(claim)).toBe(false);
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      if (pending) {
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(restarted.log).toContain("workspace:resume");
        return;
      }
      expect(restartedStore.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
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
