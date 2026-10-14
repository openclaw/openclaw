import { beforeEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementIdentity,
} from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};

describe("worker session placement store", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  beforeEach(() => {
    root = tempDirs.make("openclaw-placement-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  it("directs retired synchronous inventory and mutation APIs to their async replacements", () => {
    expect(() => store.list()).toThrow("Await listAsync");
    expect(() => store.listForReconcile()).toThrow("Await listForReconcileAsync");
    expect(() => store.listPendingWorkspaceResults()).toThrow(
      "Await listPendingWorkspaceResultsAsync",
    );
    expect(() => store.getWorkspaceResultReconcilingSessionIds([])).toThrow(
      "Await getWorkspaceResultReconcilingSessionIdsAsync",
    );
    expect(() => store.clearLocalTurnClaimsAfterRestart()).toThrow(
      "Await clearLocalTurnClaimsAfterRestartAsync",
    );
    expect(() =>
      store.retireSessionPlacement({
        sessionId: SESSION.sessionId,
        expectedState: "local",
        expectedGeneration: 0,
      }),
    ).toThrow("Await retireSessionPlacementAsync");
  });

  it("refreshes cached absence and placement state from another handle's committed writes", async () => {
    const reader = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    expect(await reader.getAsync(SESSION.sessionId)).toBeUndefined();

    const claim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "receipt-claim",
      runId: "receipt-run",
    });
    expect((await reader.getAsync(SESSION.sessionId))?.turnClaim?.claimId).toBe(claim.claimId);

    await store.releaseTurn(claim);
    expect((await reader.getAsync(SESSION.sessionId))?.turnClaim).toBeNull();
    await store.retireSessionPlacementAsync({
      sessionId: SESSION.sessionId,
      expectedState: "local",
      expectedGeneration: 0,
    });
    expect(await reader.getAsync(SESSION.sessionId)).toBeUndefined();
  });

  function advanceToActive(
    identity: WorkerSessionPlacementIdentity = SESSION,
    executionMode: WorkerPlacementExecutionMode = "worker-turn",
  ) {
    return advancePlacementFixtureToActive(
      store,
      database,
      { ...identity, executionMode },
      {
        environmentId: `environment-${identity.sessionId}`,
        remoteWorkspaceDir: `/workspace/${identity.sessionId}`,
        seedEnvironment: "before-dispatch",
      },
    );
  }

  it("closes local admission before draining the existing local turn", async () => {
    const localClaim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "run-local",
    });
    const requested = await store.startDispatch(SESSION);
    expect(requested).toMatchObject({ state: "requested", generation: 1 });
    expect(requested.turnClaim).toMatchObject({ owner: "local", generation: 0 });

    await expect(
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "new-local-claim",
        runId: "new-local-run",
      }),
    ).rejects.toThrow("already has an active turn claim");
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: localClaim.owner,
        claimId: localClaim.claimId,
        runId: localClaim.runId,
      }),
    ).rejects.toThrow("already has an active turn claim");
    await expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "environment-placement" },
      }),
    ).rejects.toThrow("during an active turn");

    const released = store.waitForTurnClaimRelease(SESSION.sessionId, {});
    await store.releaseTurn(localClaim);
    await released;
    expect(
      await store.transition({
        sessionId: SESSION.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: "environment-placement" },
      }),
    ).toMatchObject({ state: "provisioning", turnClaim: null });
  });

  it("admits exactly the active placement owner and fences stale worker epochs", async () => {
    const active = await advanceToActive();
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "local-after-dispatch",
        runId: "local-after-dispatch-run",
      }),
    ).rejects.toThrow("Local turn rejected");
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch + 1,
        },
        claimId: "stale-worker",
        runId: "stale-worker-run",
      }),
    ).rejects.toThrow("stale owner");

    const workerClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-claim",
      runId: "worker-run",
    });
    expect(store.validateTurnClaim(workerClaim)).toBe(true);
    expect(
      store.validateTurnClaim({
        ...workerClaim,
        owner: {
          kind: "worker",
          environmentId: "environment-stale",
          ownerEpoch: active.activeOwnerEpoch,
        },
      }),
    ).toBe(false);
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        claimId: "competing-worker",
        runId: "competing-worker-run",
      }),
    ).rejects.toThrow("already has an active turn claim");
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: workerClaim.owner,
        claimId: workerClaim.claimId,
        runId: workerClaim.runId,
      }),
    ).resolves.toEqual(workerClaim);
    await expect(
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: active.generation,
        recoveryError: "active worker disappeared",
      }),
    ).rejects.toThrow("Cannot fail worker session placement from active");
    const draining = await store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    expect(
      await store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "active worker disappeared",
      }),
    ).toMatchObject({ state: "failed", turnClaim: null });
    expect(store.validateTurnClaim(workerClaim)).toBe(false);
  });

  it("clears dead local claims idempotently on restart while adopting active worker ownership", async () => {
    const localIdentity = {
      ...SESSION,
      sessionId: "session-local-restart",
      sessionKey: "agent:main:local-restart",
    };
    await store.claimTurn({
      ...localIdentity,
      owner: { kind: "local" },
      claimId: "local-before-restart",
      runId: "local-restart-run",
    });
    const active = await advanceToActive();
    const workerClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-before-restart",
      runId: "worker-restart-run",
    });

    await closeStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });

    const queries = observeHostDataSql();
    try {
      expect(await store.clearLocalTurnClaimsAfterRestartAsync()).toBe(1);
      expect(await store.clearLocalTurnClaimsAfterRestartAsync()).toBe(0);
      expect(queries.queries).toEqual([]);
    } finally {
      queries.restore();
    }
    expect(store.get(localIdentity.sessionId)?.turnClaim).toBeNull();
    await store.getAsync(workerClaim.sessionId);
    expect(store.validateTurnClaim(workerClaim)).toBe(true);
    expect(
      await store.adoptActive({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toMatchObject({ state: "active", turnClaim: { owner: "worker" } });
    expect((await store.listForReconcileAsync()).map((record) => record.sessionId)).toEqual([
      SESSION.sessionId,
    ]);
    expect((await store.listAsync()).map((record) => record.sessionId)).toEqual([
      localIdentity.sessionId,
      SESSION.sessionId,
    ]);
  });

  it("closes worker admission before draining the active turn", async () => {
    const active = await advanceToActive();
    const workerClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-drain-claim",
      runId: "worker-drain-run",
    });

    const draining = await store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    expect(draining).toMatchObject({
      state: "draining",
      generation: active.generation + 1,
      turnClaim: { owner: "worker", claimId: workerClaim.claimId },
    });
    expect(store.validateTurnClaim(workerClaim)).toBe(true);

    const released = store.waitForTurnClaimRelease(SESSION.sessionId, { timeoutMs: 1_000 });
    expect(await store.releaseTurn(workerClaim)).toMatchObject({
      state: "draining",
      turnClaim: null,
    });
    await released;
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: workerClaim.owner,
        claimId: "worker-after-drain",
        runId: "worker-after-drain-run",
      }),
    ).rejects.toThrow("stale owner");
    expect(
      await store.startReconcile({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      }),
    ).toMatchObject({ state: "reconciling", turnClaim: null });
  });

  it("binds acknowledged cursors to the exact normalized worker claim", async () => {
    const active = await advanceToActive();
    const firstClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: ` ${active.environmentId} `,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-ack-first",
      runId: "worker-ack-first-run",
    });
    expect(firstClaim.owner).toEqual({
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    await store.releaseTurn(firstClaim);
    const currentClaim = await store.claimTurn({
      ...SESSION,
      owner: firstClaim.owner,
      claimId: "worker-ack-current",
      runId: "worker-ack-current-run",
    });

    await expect(store.updateAckCursors({ claim: firstClaim, transcript: 4 })).rejects.toThrow(
      "Cannot ACK stale worker turn",
    );
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBeNull();
    expect(
      await store.updateAckCursors({
        claim: currentClaim,
        transcript: 4,
        liveEvent: 9,
      }),
    ).toMatchObject({ lastTranscriptAckCursor: 4, lastLiveEventAckCursor: 9 });
    expect(
      await store.updateAckCursors({
        claim: currentClaim,
        transcript: 3,
        liveEvent: 8,
      }),
    ).toMatchObject({ lastTranscriptAckCursor: 4, lastLiveEventAckCursor: 9 });
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: SESSION.sessionId, claimId: currentClaim.claimId },
    ]);
  });

  it("fences a completed worker result until manifest acceptance clears it", async () => {
    const active = await advanceToActive();
    const claim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "pending-workspace-claim",
      runId: "pending-workspace-run",
    });
    await store.markWorkspaceResultPending(claim);

    expect(await store.listPendingWorkspaceResultsAsync(SESSION.sessionId)).toMatchObject([
      { sessionId: SESSION.sessionId, claimId: claim.claimId, workspaceAcceptedAtMs: null },
    ]);
    expect(await store.listPendingWorkspaceResultsAsync("other-session")).toEqual([]);
    expect(await store.getWorkspaceResultReconcilingSessionIdsAsync([SESSION.sessionId])).toEqual(
      new Set([SESSION.sessionId]),
    );

    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([
      {
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        placementGeneration: active.generation,
        claimId: claim.claimId,
        runId: claim.runId,
        gatewayInstanceId: store.workspaceResultInstanceId(),
        recoveryRequestedAtMs: null,
        workspaceAcceptedAtMs: null,
        stagedResultRef: null,
      },
    ]);
    await expect(store.releaseTurn(claim)).rejects.toThrow("pending cloud workspace result");

    const manifestRef = `sha256:${"f".repeat(64)}`;
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    await expect(
      store.recordStagedWorkspaceResult(claim, "refs/openclaw/worker-results/unsafe.claim"),
    ).rejects.toThrow("Worker workspace staged result reference is invalid");
    await store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, {
      paths: [" z.txt ", "a.txt", "a.txt"],
      stagedResultRef,
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toEqual({
      paths: [" z.txt ", "a.txt"],
      stagedResultRef,
      totalCount: 2,
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: active.sessionId, stagedResultRef },
    ]);
    await store.updateWorkspaceBaseManifest({ claim, manifestRef });
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: active.sessionId, workspaceAcceptedAtMs: null },
    ]);
    await store.acceptWorkspaceResult(claim);
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: active.sessionId, workspaceAcceptedAtMs: nowMs },
    ]);
    expect(await store.completeWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      turnClaim: null,
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toEqual({
      paths: [" z.txt ", "a.txt"],
      stagedResultRef,
      totalCount: 2,
    });
    const laterClaim = await store.claimTurn({
      ...SESSION,
      owner: claim.owner,
      claimId: "later-clean-claim",
      runId: "later-clean-run",
    });
    await store.markWorkspaceResultPending(laterClaim);
    store.recordWorkspaceResultConflict(laterClaim, {
      paths: Array.from(
        { length: 300 },
        (_, index) => `conflict-${index.toString().padStart(3, "0")}`,
      ),
      stagedResultRef: `refs/openclaw/worker-results/${laterClaim.claimId}`,
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict).toMatchObject({
      totalCount: 300,
      paths: expect.arrayContaining(["conflict-000", "conflict-255"]),
    });
    expect(store.get(SESSION.sessionId)?.workspaceResultConflict?.paths).toHaveLength(256);
    store.recordWorkspaceResultConflict(laterClaim, undefined);
    expect(store.get(SESSION.sessionId)).not.toHaveProperty("workspaceResultConflict");
    await store.acceptWorkspaceResult(laterClaim);
    await store.completeWorkspaceResultAndReleaseTurn(laterClaim);
    expect(await store.listPendingWorkspaceResultsAsync(SESSION.sessionId)).toEqual([]);
    expect(await store.getWorkspaceResultReconcilingSessionIdsAsync([SESSION.sessionId])).toEqual(
      new Set(),
    );
    expect(await store.getWorkspaceResultReconcilingSessionIdsAsync([SESSION.sessionId])).toEqual(
      new Set(),
    );
    expect(
      createWorkerSessionPlacementStore({ database, now: () => nowMs }).get(SESSION.sessionId),
    ).not.toHaveProperty("workspaceResultConflict");
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });
});
