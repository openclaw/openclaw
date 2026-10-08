import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";

describe("worker Gateway move recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function abandonmentFixture() {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const options = { deviceRunnerAvailable: false, workspacePath: support.testState.root };
    const harness = createHarness(support.testState.stateDb, placements, options);
    const active = await harness.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("Move source was not active");
    }
    harness.markEnvironmentNodeDeviceId("abandonment-device");
    return {
      placements,
      options,
      harness,
      active,
      request: {
        ...REQUEST,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" as const },
        abandonSource: true as const,
      },
    };
  }

  it.each(["transaction", "commit"] as const)(
    "refuses abandonment when the device runner reconnects at %s admission",
    async (stage) => {
      const { placements, options, harness, active, request } = await abandonmentFixture();
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((admissionRequest, grant) => {
            if (admissionRequest.stage === stage) {
              options.deviceRunnerAvailable = true;
            }
            admit(admissionRequest, grant);
          }, attachment),
        );
      const sql = observeMainThreadSql();
      try {
        await expect(harness.service.move(request)).rejects.toThrow("Device runner is available");
        sql.expectIdle();
      } finally {
        sql.restore();
        admission.mockRestore();
      }
      expect(options.deviceRunnerAvailable).toBe(true);
      expect(placements.get(active.sessionId)).toEqual(active);
      expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(harness.environments.stopTunnel).not.toHaveBeenCalled();
    },
  );

  it("joins a concurrent foreign abandonment after the device runner reconnects", async () => {
    const { placements, options, harness, active, request } = await abandonmentFixture();
    const operationId = "move:v1:foreign-abandonment";
    const beginMove = placements.beginPlacementMove.bind(placements);
    let joined: Awaited<ReturnType<typeof beginMove>> | undefined;
    const begin = vi
      .spyOn(placements, "beginPlacementMove")
      .mockImplementationOnce(async (input, guard) => {
        const foreign = new DatabaseSync(support.testState.stateDb.path);
        try {
          runSqliteImmediateTransactionSync(foreign, () => {
            foreign
              .prepare(`INSERT INTO worker_session_placement_moves (
            operation_id, session_id, source_generation, source_environment_id, source_owner_epoch,
            target_kind, target_id, abandon_source, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'gateway', NULL, 1, 1000, 1000)`)
              .run(
                operationId,
                active.sessionId,
                active.generation,
                active.environmentId,
                active.activeOwnerEpoch,
              );
            foreign
              .prepare(`UPDATE worker_session_placements SET state = 'draining',
            transition_generation = transition_generation + 1, updated_at_ms = 1000,
            state_changed_at_ms = 1000 WHERE session_id = ?`)
              .run(active.sessionId);
          });
        } finally {
          foreign.close();
        }
        options.deviceRunnerAvailable = true;
        joined = await beginMove(input, guard);
        return joined;
      });
    try {
      await expect(harness.service.move(request)).resolves.toMatchObject({ state: "local" });
    } finally {
      begin.mockRestore();
    }
    expect(joined).toMatchObject({ joined: true, intent: { operationId } });
    expect(placements.get(active.sessionId)?.state).toBe("local");
    expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
  });

  it("preserves the environment when Gateway move preparation loses its recovery owner", async () => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const original = createHarness(support.testState.stateDb, placements);
    const active = await original.placements.seedActive(2);
    if (active.state !== "active") {
      throw new Error("Move source was not active");
    }
    const begun = await placements.beginPlacementMove({
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
    const claim = await placements.claimReclaimWorkspaceResult({
      ...REQUEST,
      claimId: "reclaim-gateway-recovery",
      runId: "reclaim-gateway-recovery",
      owner: placementTurnOwner(begun.placement),
    });
    const restartedStore = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
    });
    let acceptedPending: Awaited<
      ReturnType<typeof restartedStore.listPendingWorkspaceResultsAsync>
    > = [];
    const prepareGatewayMove = vi.fn<
      NonNullable<Parameters<typeof createWorkerPlacementDispatchService>[0]["prepareGatewayMove"]>
    >(async ({ assertCurrent }) => {
      assertCurrent();
      await Promise.resolve();
      acceptedPending = await restartedStore.listPendingWorkspaceResultsAsync();
      expect(acceptedPending).toMatchObject([
        { workspaceAcceptedAtMs: expect.any(Number), stagedResultRef: null },
      ]);
      // A concurrent durable owner replaces the claim without consuming its result.
      support.testState.stateDb.db
        .prepare(
          "UPDATE worker_session_placements SET turn_claim_id = ?, turn_claim_run_id = ? WHERE session_id = ? AND turn_claim_id = ?",
        )
        .run("replacement-claim", "replacement-run", active.sessionId, claim.claimId);
      await expect(restartedStore.prepareWorkspaceResultClaim(claim)).rejects.toThrow(
        "workspace result authority changed",
      );
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
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual(acceptedPending);
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
      const active = await seedActivePlacement(placements, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      if (active.state !== "active") {
        throw new Error("Move source was not active");
      }
      const begun = await placements.beginPlacementMove({
        sessionId: active.sessionId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      });
      const reconciling = await placements.startReconcile({
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
          await restartedStore.cancelPlacementMove({
            operationId: begun.intent.operationId,
            sessionId: active.sessionId,
          });
          await restartedStore.fail({
            sessionId: active.sessionId,
            expectedGeneration: reconciling.generation,
            recoveryError: "source replaced",
          });
          seedAttachedPlacementEnvironment(support.testState.stateDb, {
            environmentId: "replacement-environment",
            sessionId: REQUEST.sessionId,
            ownerEpoch: 9,
          });
          replacement = await seedActivePlacement(restartedStore, {
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
