import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";

describe("worker Gateway move recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("preserves the environment when Gateway move preparation loses its recovery owner", async () => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const original = createHarness(support.testState.stateDb, placements);
    const active = original.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("Move source was not active");
    }
    const begun = placements.beginPlacementMove({
      sessionId: active.sessionId,
      source: {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    if (begun.placement.state !== "draining") {
      throw new Error("Move source did not enter draining state");
    }
    const claim = placements.claimReclaimWorkspaceResult({
      ...REQUEST,
      claimId: "reclaim-gateway-recovery",
      runId: "reclaim-gateway-recovery",
      owner: placementTurnOwner(begun.placement),
    });
    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
    });
    let acceptedPending: ReturnType<typeof restartedStore.listPendingWorkspaceResults> = [];
    const prepareGatewayMove = vi.fn<
      NonNullable<Parameters<typeof createWorkerPlacementDispatchService>[0]["prepareGatewayMove"]>
    >(async ({ assertCurrent }) => {
      assertCurrent();
      await Promise.resolve();
      acceptedPending = restartedStore.listPendingWorkspaceResults();
      expect(acceptedPending).toMatchObject([
        { workspaceAcceptedAtMs: expect.any(Number), stagedResultRef: null },
      ]);
      // A concurrent durable owner replaces the claim without consuming its result.
      support.testState.stateDb.db
        .prepare(
          "UPDATE worker_session_placements SET turn_claim_id = ?, turn_claim_run_id = ? WHERE session_id = ? AND turn_claim_id = ?",
        )
        .run("replacement-claim", "replacement-run", active.sessionId, claim.claimId);
      expect(restartedStore.validateWorkspaceResultClaim(claim)).toBe(false);
    });
    const restarted = createHarness(support.testState.stateDb, restartedStore, {
      prepareGatewayMove,
    });
    restarted.markEnvironmentOwnerEpoch(2);

    await restarted.service.reconcile("startup");

    expect(prepareGatewayMove).toHaveBeenCalledOnce();
    await expect(prepareGatewayMove.mock.results[0]?.value).resolves.toBeUndefined();
    expect(restarted.environments.destroy).not.toHaveBeenCalled();
    expect(restarted.environments.stopTunnel).not.toHaveBeenCalled();
    expect(restarted.environments.get(active.environmentId)?.state).toBe("attached");
    expect(restartedStore.listPendingWorkspaceResults()).toEqual(acceptedPending);
    expect(restartedStore.get(active.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: "replacement-claim", runId: "replacement-run" },
    });
    expect(restartedStore.getPlacementMove(active.sessionId)?.operationId).toBe(
      begun.intent.operationId,
    );
  });

  it.each(["current", "replaced"] as const)(
    "materializes a torn-down Gateway move before local recovery while its owner is %s",
    async (owner) => {
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const original = createHarness(support.testState.stateDb, placements);
      const ready = await support.seedReady(original.ready.environmentId);
      const environments = support.createService(support.createProvider());
      const attached = await environments.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const active = seedActivePlacement(placements, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (active.state !== "active") {
        throw new Error("Move source was not active");
      }
      const begun = placements.beginPlacementMove({
        sessionId: active.sessionId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      });
      const reconciling = placements.startReconcile({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: begun.placement.generation,
      });
      await environments.destroy(active.environmentId);
      await support.reopenWorkerEnvironmentStore();
      expect(support.testState.store.get(active.environmentId)?.state).toBe("destroyed");
      const restartedStore = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const checkout = path.join(support.testState.root, "recovered-checkout");
      const file = path.join(checkout, "result.txt");
      const prepareGatewayMove = vi.fn<
        NonNullable<
          Parameters<typeof createWorkerPlacementDispatchService>[0]["prepareGatewayMove"]
        >
      >(async ({ sessionId, sessionKey, agentId, assertCurrent }) => {
        expect({ sessionId, sessionKey, agentId }).toEqual({
          sessionId: active.sessionId,
          sessionKey: active.sessionKey,
          agentId: active.agentId,
        });
        assertCurrent();
        entered.resolve();
        await release.promise;
        assertCurrent();
        await fs.mkdir(checkout);
        await fs.writeFile(file, "accepted repository result\n");
        expect(restartedStore.get(active.sessionId)?.state).toBe("reconciling");
      });
      const restarted = createHarness(support.testState.stateDb, restartedStore, {
        prepareGatewayMove,
      });
      restarted.markEnvironmentDestroyed();
      let replacement: ReturnType<typeof restartedStore.get>;
      const recovering = restarted.service.reconcile();
      try {
        await Promise.race([entered.promise, recovering]);
        expect(prepareGatewayMove).toHaveBeenCalledOnce();
        expect(restartedStore.get(active.sessionId)).toEqual(reconciling);
        expect(restarted.log).not.toContain("placement:local");
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        if (owner === "replaced") {
          restartedStore.cancelPlacementMove({
            operationId: begun.intent.operationId,
            sessionId: active.sessionId,
          });
          restartedStore.fail({
            sessionId: active.sessionId,
            expectedGeneration: reconciling.generation,
            recoveryError: "source replaced",
          });
          seedAttachedPlacementEnvironment(support.testState.stateDb, {
            environmentId: "replacement-environment",
            sessionId: REQUEST.sessionId,
            ownerEpoch: 9,
          });
          replacement = seedActivePlacement(restartedStore, {
            environmentId: "replacement-environment",
            ownerEpoch: 9,
          });
        }
      } finally {
        release.resolve();
        await recovering;
      }
      if (owner === "replaced") {
        await expect(prepareGatewayMove.mock.results[0]?.value).rejects.toThrow(
          "lost its source owner",
        );
        expect(restartedStore.get(active.sessionId)).toEqual(replacement);
        expect(restarted.log).not.toContain("placement:local");
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(file, "utf8")).toBe("accepted repository result\n");
        expect(restartedStore.get(active.sessionId)?.state).toBe("local");
        expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
      }
      expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
    },
  );
});
