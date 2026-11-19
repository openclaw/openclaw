import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  sessionIdentity,
  placementClaim,
  placementTransition,
} from "./placement-suite.test-support.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import { matchesWorkspaceResultClaim } from "./placement-workspace-result-owner.js";
import { prepareSessionWorkerPlacementMutationCheckAsync } from "./session-placement-lifecycle.js";
import { createWorkerEnvironmentStore } from "./store.js";

describe("worker placement authority retained boundaries", () => {
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      try {
        await drainGlobalSingletonLifecycleState();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        cleanup();
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  let database: OpenClawStateDatabase;
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-projection-"));
    database = openOpenClawStateDatabase();
  });

  it("discovers retained workspace data after placements become local or reclaimed", async () => {
    const insert = (table: string, values: Record<string, SQLInputValue>) => {
      const columns = Object.keys(values).map((key) =>
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      );
      database.db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(values));
    };
    for (const [sessionId, state] of [
      ["result-reclaimed", "reclaimed"],
      ["journal-local", "local"],
      ["move-local", "local"],
      ["idle-local", "local"],
      ["idle-reclaimed", "reclaimed"],
    ] as const) {
      insert("worker_session_placements", {
        ...sessionIdentity(sessionId),
        state,
        transitionGeneration: 7,
        environmentId: state === "reclaimed" ? `env-${sessionId}` : null,
        activeOwnerEpoch: state === "reclaimed" ? 7 : null,
        workspaceBaseManifestRef: state === "reclaimed" ? `sha256:${"a".repeat(64)}` : null,
        remoteWorkspaceDir: state === "reclaimed" ? "/workspace" : null,
        workerBundleHash: state === "reclaimed" ? "b".repeat(64) : null,
        createdAtMs: 0,
        updatedAtMs: 0,
        stateChangedAtMs: 0,
      });
    }
    insert("worker_workspace_pending_results", {
      sessionId: "result-reclaimed",
      environmentId: "env-result-reclaimed",
      ownerEpoch: 7,
      placementGeneration: 7,
      claimId: "claim-reclaimed",
      runId: "run-reclaimed",
      gatewayInstanceId: "previous-gateway",
      recoveryRequestedAtMs: 11,
      workspaceAcceptedAtMs: 12,
      stagedResultRef: "refs/openclaw/worker-results/reclaimed",
      createdAtMs: 0,
    });
    database.db
      .prepare(`INSERT INTO worker_workspace_reconciliations
        (session_id, environment_id, owner_epoch, placement_generation, base_manifest_ref,
         current_manifest_ref, plan_json, base_pack, created_at_ms)
        VALUES ('journal-local', 'env-journal-local', 7, 7, 'base', 'current', '{}', X'', 0)`)
      .run();
    insert("worker_session_placement_moves", {
      operationId: "move:v1:local",
      sessionId: "move-local",
      sourceGeneration: 7,
      sourceEnvironmentId: "source-move-local",
      sourceOwnerEpoch: 7,
      targetKind: "gateway",
      createdAtMs: 0,
      updatedAtMs: 0,
    });
    const store = createWorkerSessionPlacementStore({ database });
    const candidates = new Map(
      (await store.readRecoveryCandidates()).map((candidate) => [candidate.sessionId, candidate]),
    );
    expect([...candidates.keys()].toSorted()).toEqual([
      "journal-local",
      "move-local",
      "result-reclaimed",
    ]);
    for (const candidate of candidates.values()) {
      expect(candidate.workspaceRecoveryPending).toBe(true);
    }
    expect(candidates.get("move-local")?.moveSourceEnvironmentId).toBe("source-move-local");
  });

  function retentionTransport(
    node: ReturnType<typeof createNodeWorkerBundleTestNode>,
    invoke: NodeWorkerSupervisorTransport["invoke"],
  ) {
    return {
      getCurrentNode: async () => node,
      listCurrentNodes: async () => [node],
      hasCurrentRunner: () => true,
      isCurrent: () => true,
      invoke,
    };
  }

  async function activePlacement(
    sessionId: string,
    executionMode: WorkerPlacementExecutionMode = "worker-turn",
  ) {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
    const identity = sessionIdentity(sessionId);
    const environmentId = `environment-${sessionId}`;
    const placement = await advancePlacementFixtureToActive(
      store,
      database,
      { ...identity, executionMode },
      {
        environmentId,
        remoteWorkspaceDir: "/workspace",
        seedEnvironment: "before-dispatch",
      },
    );
    return { store, placement, identity };
  }

  it("keeps projection and environment ownership bound to their physical database", async () => {
    const { store, placement, identity } = await activePlacement("pending");
    const claim = await store.claimTurn(placementClaim(placement, "pending"));
    await store.markWorkspaceResultPending(claim);
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    await store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, { paths: ["changed.txt"], stagedResultRef });
    const draining = await store.startWorkspaceResultDrain(claim);
    const pendingResult = (await store.listPendingWorkspaceResultsAsync("pending"))[0];

    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-projection-other-"));
    const other = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    const requested = await other.startDispatch(identity);
    await closeOpenClawStateDatabaseAsync();

    const projection = await store.readProjection([identity.sessionId]);
    expect(projection.placements.get(identity.sessionId)).toMatchObject({
      state: "draining",
      generation: draining.generation,
      workspaceResultConflict: { paths: ["changed.txt"], stagedResultRef, totalCount: 1 },
    });
    expect(projection.pendingResults.get(identity.sessionId)).toEqual(pendingResult);
    expect(projection.environments.get(placement.environmentId)).toMatchObject({
      environmentId: placement.environmentId,
      ownerEpoch: 7,
      attachedSessionIds: [identity.sessionId],
    });
    expect(
      (await other.readProjection([identity.sessionId])).placements.get(identity.sessionId),
    ).toEqual(requested);

    await closeOpenClawStateDatabaseAsync();
    expect(await store.readEnvironmentOwner(placement.environmentId)).toMatchObject({
      sessionId: identity.sessionId,
      state: "draining",
      generation: draining.generation,
    });
    const reopened = await store.readProjection([identity.sessionId]);
    expect(reopened.placements.get(identity.sessionId)?.generation).toBe(draining.generation);
    expect(reopened.pendingResults.get(identity.sessionId)).toEqual(pendingResult);
  });

  it("rejects stale journal ownership without losing pending recovery work", async () => {
    const insert = (table: string, values: Record<string, SQLInputValue>) => {
      const columns = Object.keys(values).map((key) =>
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      );
      database.db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...Object.values(values));
    };
    const ids = ["journal-current", "journal-draining", "journal-stale"];
    for (const sessionId of ids) {
      const current = sessionId === "journal-current";
      insert("worker_session_placements", {
        ...sessionIdentity(sessionId),
        state: current ? "active" : "draining",
        transitionGeneration: current ? 7 : 8,
        environmentId: `env-${sessionId}`,
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: "b".repeat(64),
        createdAtMs: 0,
        updatedAtMs: 0,
        stateChangedAtMs: 0,
      });
      database.db
        .prepare(`INSERT INTO worker_workspace_reconciliations
          (session_id, environment_id, owner_epoch, placement_generation, base_manifest_ref,
           current_manifest_ref, plan_json, base_pack, created_at_ms)
          VALUES (?, ?, 7, 7, 'base', 'current', '{}', X'', 0)`)
        .run(sessionId, `env-${sessionId}`);
      insert("worker_workspace_pending_results", {
        sessionId,
        environmentId: `env-${sessionId}`,
        ownerEpoch: sessionId === "journal-stale" ? 8 : 7,
        placementGeneration: 7,
        claimId: `claim-${sessionId}`,
        runId: `run-${sessionId}`,
        gatewayInstanceId: "previous-gateway",
        recoveryRequestedAtMs: current ? null : 11,
        workspaceAcceptedAtMs: null,
        stagedResultRef: current ? null : `refs/openclaw/worker-results/${sessionId}`,
        createdAtMs: 0,
      });
    }
    const store = createWorkerSessionPlacementStore({ database });
    const owners = await store.listWorkspaceReconciliationOwners();
    const placements = await Promise.all(
      owners.map((owner) => store.getWorkspaceReconciliationPlacement(owner)),
    );
    const accepted = new Set(
      owners.filter((_owner, index) => placements[index]).map((owner) => owner.sessionId),
    );
    expect(accepted).toEqual(new Set(["journal-current", "journal-draining"]));
    const projection = await store.readProjection(ids, { current: true });
    expect(projection.workspaceJournalOwnerSessionIds).toEqual(accepted);
    expect(projection.workspaceResultReconcilingSessionIds).toEqual(new Set(["journal-draining"]));
    expect(projection.workspaceRecoveryPendingSessionIds).toEqual(new Set(ids));
    expect(projection.pendingResults.get("journal-stale")?.ownerEpoch).toBe(8);
    expect(
      (await store.readRecoveryCandidates()).find((row) => row.sessionId === "journal-stale"),
    ).toMatchObject({ workspaceRecoveryPending: true });
  });

  it("fences a placement created after absence was captured", async () => {
    const store = createWorkerSessionPlacementStore({ database });
    const first = await store.startDispatch(sessionIdentity("first"));
    const second = await store.startDispatch(sessionIdentity("second"));
    await store.getManyAsync([first.sessionId]);
    expect(await store.getManyAsync([" first ", "first", "missing"])).toEqual(
      new Map([[first.sessionId, first]]),
    );
    expect(await store.getAsync(` ${second.sessionId} `)).toEqual(second);
    expect(await store.getAsync("late-placement")).toBeUndefined();
    await expect(store.getAsync(" ")).rejects.toThrow("session id");
    expect(await store.getPlacementMoveAsync(second.sessionId)).toBeUndefined();
    expect(await store.listAsync()).toEqual([first, second]);
    expect(await store.listForReconcileAsync(second.sessionKey)).toEqual([second]);
    const assertCurrent = await prepareSessionWorkerPlacementMutationCheckAsync({
      context: { workerSessionPlacementService: store },
      sessionId: "late-placement",
    });
    assertCurrent();
    const late = await store.startDispatch(sessionIdentity("late-placement"));
    expect(assertCurrent).toThrow("placement late-placement changed before mutation");
    expect(await store.getAsync(" late-placement ")).toEqual(late);
  });

  it("fences drained dispatch while preserving accepted completion", async () => {
    const { store, placement } = await activePlacement("node-retention");
    await store.claimTurn(placementClaim(placement, "retained"));
    const environments = await createWorkerEnvironmentStore({ database });
    const node = createNodeWorkerBundleTestNode();
    const environment = environments.get(placement.environmentId!);
    if (!environment) {
      throw new Error("Expected the seeded worker environment");
    }
    const nodeEnvironment = {
      ...environment,
      nodeDeviceId: node.nodeId,
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "connected" as const,
    };
    const entered = createDeferred<Parameters<NodeWorkerSupervisorTransport["invoke"]>[0]>();
    const reply = createDeferred();
    const warn = vi.fn();
    const coordinator = createNodeWorkspaceRetainCoordinator({
      gatewayNamespace: "gateway-retention",
      placements: store,
      environments: { list: () => [nodeEnvironment] },
      warn,
    });
    coordinator.bindTransport(
      retentionTransport(node, async (request) => {
        entered.resolve(request);
        await reply.promise;
        return {
          ok: true,
          payloadJSON: JSON.stringify({ applied: true, deleted: 0, hasMore: false }),
        };
      }),
    );
    const startup = coordinator.start();
    try {
      const request = await awaitGateBeforeSettlement(
        entered.promise,
        startup,
        "retention was not dispatched",
      );
      expect(request.params).toMatchObject({
        retain: [expect.objectContaining({ manifestRefs: null })],
      });
      expect(request.isDispatchAuthorized()).toBe(true);
      await store.startDispatch(sessionIdentity("unrelated"));
      expect(request.isDispatchAuthorized()).toBe(true);
      await store.startDrain(placementTransition(placement));
      expect(request.isDispatchAuthorized()).toBe(false);
      expect(request.isCompletionAuthorized?.()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      reply.resolve();
      await startup;
      await coordinator.stop();
      await environments.close();
    }
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "fences observations during %s publication settlement",
    async (kind) => {
      const store = createWorkerSessionPlacementStore({ database });
      const session = sessionIdentity("settling-placement");
      const { placement: current } = await activePlacement(session.sessionId, kind);
      await store.claimTurn({
        ...session,
        owner: placementTurnOwner(current),
        claimId: "settling-claim",
        runId: "settling-run",
      });
      const placement = store.get(session.sessionId)!;
      const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
      for (const settlement of ["rollback", "commit", "invalidate"] as const) {
        const sessionRead = await store.prepareRuntimeRefresh(session.sessionId);
        const publication = stagePlacementTurnClaimWorkerPublication(
          identity,
          placement,
          undefined,
          placement.state,
        );
        try {
          sessionRead.placement!.agentId = "caller-agent";
          sessionRead.placement!.turnClaim!.claimId = "caller-claim";
          expect(
            (await store.readProjection([session.sessionId])).placements.get(session.sessionId),
          ).toMatchObject({ agentId: session.agentId, turnClaim: { claimId: "settling-claim" } });
          expect(() => sessionRead.assertCurrent()).toThrow("placement authority changed");
          publication[settlement]();
          if (settlement === "rollback") {
            sessionRead.assertCurrent();
          } else {
            expect(() => sessionRead.assertCurrent()).toThrow("placement authority changed");
          }
        } finally {
          publication.rollback();
          sessionRead.release();
        }
      }
      const closing = await store.prepareMaintenancePlacements();
      try {
        await closeOpenClawStateDatabaseAsync();
        expect(() => closing.assertCurrent()).toThrow();
      } finally {
        closing.release();
      }
    },
  );

  it("prepares live and claimless result authority for both execution modes", async () => {
    for (const executionMode of ["worker-turn", "remote-exec"] as const) {
      const { store, placement, identity } = await activePlacement(executionMode, executionMode);
      const claim = await store.claimTurn(placementClaim(placement, executionMode));
      await store.markWorkspaceResultPending(claim);
      for (const claimless of [false, true]) {
        if (claimless) {
          if (executionMode === "remote-exec") {
            expect(await store.clearLocalTurnClaimsAfterRestartAsync()).toBe(1);
          } else {
            database.db
              .prepare(`UPDATE worker_session_placements SET turn_claim_owner = NULL, turn_claim_id = NULL,
              turn_claim_run_id = NULL, turn_claim_generation = NULL, turn_claim_owner_epoch = NULL WHERE session_id = ?`)
              .run(identity.sessionId);
          }
        }
        const projection = await store.readProjection([identity.sessionId], { current: true });
        const projectedPlacement = projection.placements.get(identity.sessionId)!;
        const pending = projection.pendingResults.get(identity.sessionId)!;
        for (const testedClaim of [
          claim,
          { ...claim, claimId: "different-claim" },
          { ...claim, runId: "different-run" },
          { ...claim, placementGeneration: claim.placementGeneration + 1 },
          { ...claim, owner: { ...claim.owner, environmentId: "different-environment" } },
          { ...claim, owner: { ...claim.owner, ownerEpoch: 8 } },
        ]) {
          const expected = testedClaim === claim && (!claimless || executionMode === "remote-exec");
          if (expected) {
            await store.prepareWorkspaceResultClaim(testedClaim);
          } else {
            await expect(store.prepareWorkspaceResultClaim(testedClaim)).rejects.toThrow(
              "workspace result authority changed",
            );
          }
          expect(store.validateWorkspaceResultClaim(testedClaim)).toBe(expected);
          expect(matchesWorkspaceResultClaim(projectedPlacement, pending, testedClaim)).toBe(
            expected,
          );
        }
      }
    }
  });
});
