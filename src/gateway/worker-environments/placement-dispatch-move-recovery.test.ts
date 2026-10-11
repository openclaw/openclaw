import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

describe("worker Gateway move recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

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
      const admission = probe.admission(operationAdmission, (admissionRequest, grant, admit) => {
        if (admissionRequest.stage === stage) {
          options.deviceRunnerAvailable = true;
        }
        admit(admissionRequest, grant);
      });
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

  it.each(["claim-replaced", "policy-activated", "policy-after-prepare"] as const)(
    "preserves the accepted checkpoint when pending Gateway move recovery is %s",
    async (mode) => {
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
      const recoveredFile = path.join(support.testState.root, "forbidden-gateway-checkout");
      const prepareGatewayMove = vi.fn<
        NonNullable<
          Parameters<typeof createWorkerPlacementDispatchService>[0]["prepareGatewayMove"]
        >
      >(async ({ assertCurrent }) => {
        assertCurrent();
        await Promise.resolve();
        acceptedPending = await restartedStore.listPendingWorkspaceResultsAsync();
        expect(acceptedPending).toMatchObject([
          { workspaceAcceptedAtMs: expect.any(Number), stagedResultRef: null },
        ]);
        if (mode === "policy-after-prepare") {
          queueMicrotask(() =>
            queueMicrotask(() =>
              setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } }),
            ),
          );
          return;
        }
        if (mode === "policy-activated") {
          setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });
          assertCurrent();
          await fs.writeFile(recoveredFile, "accepted repository result\n");
          return;
        }
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
      if (mode === "policy-activated") {
        await expect(prepareGatewayMove.mock.results[0]?.value).rejects.toThrow(
          "required worker profile policy",
        );
        await expect(fs.stat(recoveredFile)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(prepareGatewayMove.mock.results[0]?.value).resolves.toBeUndefined();
      }
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
      expect(restarted.environments.stopTunnel).not.toHaveBeenCalled();
      expect(restarted.environments.get(active.environmentId)?.state).toBe("attached");
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual(acceptedPending);
      expect(restartedStore.get(active.sessionId)).toMatchObject({
        state: "draining",
        turnClaim:
          mode === "claim-replaced"
            ? { claimId: "replacement-claim", runId: "replacement-run" }
            : { claimId: claim.claimId, runId: claim.runId },
      });
      expect(restartedStore.getPlacementMove(active.sessionId)?.operationId).toBe(
        begun.intent.operationId,
      );
    },
  );

  it.each([
    { kind: "ordinary", source: "attached" },
    { kind: "reclaim", source: "attached" },
    { kind: "ordinary", source: "destroyed" },
    { kind: "reclaim", source: "destroyed-missing-ref" },
  ] as const)(
    "Stop settles an accepted $kind result with $source source without resuming a policy-rejected Gateway move",
    async ({ kind, source }) => {
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const original = createHarness(support.testState.stateDb, placements);
      const active = await original.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("Move source was not active");
      }
      let claim =
        kind === "ordinary"
          ? await placements.claimTurn({
              ...REQUEST,
              claimId: "ordinary-policy-stop",
              runId: "ordinary-policy-stop",
              owner: placementTurnOwner(active),
            })
          : undefined;
      await placements.beginPlacementMove({
        sessionId: active.sessionId,
        source: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      });
      if (claim) {
        await placements.markWorkspaceResultPending(claim);
      } else {
        claim = await placements.claimReclaimWorkspaceResult({
          ...REQUEST,
          claimId: "reclaim-policy-stop",
          runId: "reclaim-policy-stop",
          owner: placementTurnOwner(active),
        });
      }
      if (source === "destroyed-missing-ref") {
        await placements.recordStagedWorkspaceResult(
          claim,
          workerWorkspaceResultRef(claim.claimId),
        );
      }
      await placements.acceptWorkspaceResult(claim);
      await placements.handoffWorkspaceResultRecovery(claim);
      const pending = await placements.listPendingWorkspaceResultsAsync();
      const entry = { sessionId: active.sessionId, updatedAt: 1 };
      const target = {
        storePath: path.join(support.testState.root, "sessions.sqlite"),
        canonicalKey: active.sessionKey,
        storeKeys: [active.sessionKey],
        agentId: active.agentId,
        store: { [active.sessionKey]: entry },
      };
      const barriers = createGatewayWorkerPlacementReclaimBarriers({
        placements,
        loadSessionRuntime: async () => ({
          managedWorktrees: { findLiveByOwner: async () => undefined },
          resolveGatewaySessionStoreTargetWithStore: () => target,
          resolveCanonicalSessionEntryFromStoreKeys: () => entry,
        }),
        cancelSessionWork: async ({ assertCurrent }) => assertCurrent(),
        revokeSessionAuthority: vi.fn(),
      });
      const prepareGatewayMove = vi.fn();
      const stopping = createHarness(support.testState.stateDb, placements, {
        runReclaimPreparation: barriers.runReclaimPreparation,
        prepareGatewayMove,
      });
      stopping.markEnvironmentOwnerEpoch(2);
      if (source !== "attached") {
        stopping.markEnvironmentDestroyed();
      }
      setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });
      // Wake the real recovery owner at the real claim-wait boundary, without timers.
      const waitForRelease = placements.waitForTurnClaimRelease;
      vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementation(
        async (sessionId, options) => {
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
          await stopping.service.reconcileActive(active.environmentId);
          expect(placements.get(active.sessionId)?.turnClaim).toBeNull();
          await waitForRelease(sessionId, options);
        },
      );

      await expect(stopping.service.reclaim(REQUEST)).resolves.toMatchObject({
        state: "reclaimed",
        workspaceBaseManifestRef:
          source === "attached" ? stopping.reconciledManifestRef : active.workspaceBaseManifestRef,
        turnClaim: null,
      });
      expect(prepareGatewayMove).not.toHaveBeenCalled();
      expect(stopping.environments.destroy).toHaveBeenCalledTimes(source === "attached" ? 1 : 0);
      expect(stopping.log).not.toContain("placement:local");
      expect(placements.getPlacementMove(active.sessionId)).toBeUndefined();
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    },
  );

  it.each([
    "current",
    "replaced",
    "foreign-generation",
    "foreign-move",
    "policy-required",
    "policy-activated",
    "policy-at-transaction",
    "policy-at-commit",
  ] as const)(
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
      let restoreAdmission: (() => void) | undefined;
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
        if (owner === "policy-at-transaction" || owner === "policy-at-commit") {
          const stage = owner === "policy-at-transaction" ? "transaction" : "commit";
          const admission = probe.admission(operationAdmission, (request, grant, admit) => {
            if (request.stage === stage) {
              setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });
            }
            admit(request, grant);
          });
          restoreAdmission = () => admission.mockRestore();
        }
      });
      const restarted = createHarness(support.testState.stateDb, restartedStore, {
        prepareGatewayMove,
      });
      restarted.markEnvironmentDestroyed();
      let replacement: ReturnType<typeof restartedStore.get>;
      if (owner === "policy-required") {
        setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });
      }
      const recovering = restarted.service.reconcile();
      try {
        await Promise.race([entered.promise, recovering]);
        expect(prepareGatewayMove).toHaveBeenCalledTimes(owner === "policy-required" ? 0 : 1);
        expect(restartedStore.get(active.sessionId)).toEqual(reconciling);
        expect(restarted.log).not.toContain("placement:local");
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        if (owner === "policy-activated") {
          setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });
        }
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
        if (owner === "foreign-generation" || owner === "foreign-move") {
          const foreign = new DatabaseSync(support.testState.stateDb.path);
          try {
            if (owner === "foreign-generation") {
              foreign
                .prepare(
                  `UPDATE worker_session_placements
                   SET transition_generation = transition_generation + 1 WHERE session_id = ?`,
                )
                .run(active.sessionId);
            } else {
              foreign
                .prepare(
                  "UPDATE worker_session_placement_moves SET operation_id = ? WHERE session_id = ?",
                )
                .run("move:v1:foreign-replacement", active.sessionId);
            }
          } finally {
            foreign.close();
          }
          // Leave the foreign commit unobserved until the final effect guard.
          replacement =
            owner === "foreign-generation"
              ? { ...reconciling, generation: reconciling.generation + 1 }
              : reconciling;
        }
      } finally {
        release.resolve();
        try {
          await recovering;
        } finally {
          restoreAdmission?.();
        }
      }
      if (owner === "replaced" || owner === "foreign-generation" || owner === "foreign-move") {
        await expect(prepareGatewayMove.mock.results[0]?.value).rejects.toThrow(
          "lost its source owner",
        );
        expect(restartedStore.get(active.sessionId)).toEqual(replacement);
        if (owner === "foreign-move") {
          expect(restartedStore.getPlacementMove(active.sessionId)?.operationId).toBe(
            "move:v1:foreign-replacement",
          );
        }
        expect(restarted.log).not.toContain("placement:local");
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      } else if (
        owner === "policy-required" ||
        owner === "policy-activated" ||
        owner === "policy-at-transaction" ||
        owner === "policy-at-commit"
      ) {
        if (owner === "policy-activated") {
          await expect(prepareGatewayMove.mock.results[0]?.value).rejects.toThrow(
            "required worker profile policy",
          );
        }
        expect(restartedStore.get(active.sessionId)).toEqual(reconciling);
        expect(restartedStore.getPlacementMove(active.sessionId)).toMatchObject({
          operationId: begun.intent.operationId,
          lastError: expect.stringContaining("required worker profile policy"),
        });
        if (owner === "policy-at-transaction" || owner === "policy-at-commit") {
          expect(await fs.readFile(file, "utf8")).toBe("accepted repository result\n");
        } else {
          await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } else {
        expect(await fs.readFile(file, "utf8")).toBe("accepted repository result\n");
        expect(restartedStore.get(active.sessionId)?.state).toBe("local");
        expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
      }
      expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
      expect(restarted.environments.destroy).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "required profile",
      target: { kind: "profile" as const, profileId: "development" },
      allowed: true,
    },
    {
      name: "reassigned profile",
      target: { kind: "profile" as const, profileId: "previous" },
      allowed: false,
    },
    { name: "Gateway target", target: { kind: "gateway" as const }, allowed: false },
  ])(
    "recovers a persisted draining $name under current policy without blocking Stop",
    async ({ target, allowed }) => {
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
        target,
      });
      await support.reopenWorkerEnvironmentStore();
      const restartedStore = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
      });
      const prepareGatewayMove = vi.fn();
      const restarted = createHarness(support.testState.stateDb, restartedStore, {
        prepareGatewayMove,
      });
      restarted.markEnvironmentOwnerEpoch(2);
      setRuntimeConfigSnapshot({ cloudWorkers: { requiredProfile: "development" } });

      await restarted.service.reconcile("startup");

      expect(prepareGatewayMove).not.toHaveBeenCalled();
      if (allowed) {
        expect(restarted.environments.startTunnel).toHaveBeenCalledOnce();
        expect(restarted.environments.destroy).toHaveBeenCalledOnce();
        expect(restartedStore.get(active.sessionId)).toMatchObject({
          state: "failed",
          recoveryError: expect.stringContaining("authority expired"),
        });
        expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
      } else {
        expect(restarted.environments.startTunnel).not.toHaveBeenCalled();
        expect(restarted.environments.destroy).not.toHaveBeenCalled();
        expect(restartedStore.get(active.sessionId)).toEqual(begun.placement);
        expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(restartedStore.getPlacementMove(active.sessionId)).toMatchObject({
          operationId: begun.intent.operationId,
          lastError: expect.stringContaining("required worker profile policy"),
        });
        // Stop cleans the remote source without resuming the forbidden move target.
        await expect(restarted.service.reclaim(REQUEST)).resolves.toMatchObject({
          state: "reclaimed",
        });
        expect(restarted.environments.destroy).toHaveBeenCalledOnce();
        expect(prepareGatewayMove).not.toHaveBeenCalled();
        expect(restartedStore.getPlacementMove(active.sessionId)).toBeUndefined();
      }
    },
  );
});
