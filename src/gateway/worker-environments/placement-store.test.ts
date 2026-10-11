import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("keeps the draining local claim releasable when the dispatch barrier fails", async () => {
    const localClaim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "local-barrier-claim",
      runId: "local-barrier-run",
    });
    const requested = await store.startDispatch(SESSION);
    const failed = await store.fail({
      sessionId: SESSION.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "local drain timed out",
    });

    expect(failed).toMatchObject({
      state: "failed",
      recoveryError: "local drain timed out",
      turnClaim: { owner: "local", claimId: localClaim.claimId },
    });
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: { kind: "local" },
        claimId: "new-local-claim",
        runId: "new-local-run",
      }),
    ).rejects.toThrow("already has an active turn claim");
    expect(await store.releaseTurn(localClaim)).toMatchObject({ state: "failed", turnClaim: null });
  });

  it("does not let a stale claim release a later turn that reuses the run id", async () => {
    const firstClaim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "first-claim-token",
      runId: "reused-run",
    });
    await store.releaseTurn(firstClaim);
    const secondClaim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local" },
      claimId: "second-claim-token",
      runId: firstClaim.runId,
    });

    await expect(store.releaseTurn(firstClaim)).rejects.toThrow(
      "turn claim changed before release",
    );
    expect(store.validateTurnClaim(secondClaim)).toBe(true);
    expect(store.get(SESSION.sessionId)?.turnClaim).toMatchObject({
      claimId: secondClaim.claimId,
      runId: secondClaim.runId,
    });
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

  it("clears dead local claims on restart while adopting active worker ownership", async () => {
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

    expect(store.clearLocalTurnClaimsAfterRestart()).toBe(1);
    expect(store.get(localIdentity.sessionId)?.turnClaim).toBeNull();
    expect(store.validateTurnClaim(workerClaim)).toBe(true);
    expect(
      await store.adoptActive({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toMatchObject({ state: "active", turnClaim: { owner: "worker" } });
    expect(store.listForReconcile().map((record) => record.sessionId)).toEqual([SESSION.sessionId]);
    expect(store.list().map((record) => record.sessionId)).toEqual([
      localIdentity.sessionId,
      SESSION.sessionId,
    ]);
  });

  it("fences remote-exec local claims and clears them after restart", async () => {
    const active = await advanceToActive(SESSION, "remote-exec");
    const placementOwner = {
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    await expect(
      store.claimTurn({
        ...SESSION,
        owner: { kind: "worker", ...placementOwner },
        claimId: "remote-worker-claim",
        runId: "remote-worker-run",
      }),
    ).rejects.toThrow("stale owner");
    const claim = await store.claimTurn({
      ...SESSION,
      owner: { kind: "local", ...placementOwner },
      claimId: "remote-local-claim",
      runId: "remote-local-run",
    });
    expect(store.validateTurnClaim(claim)).toBe(true);

    await closeStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });

    expect(store.clearLocalTurnClaimsAfterRestart()).toBe(1);
    expect(store.get(SESSION.sessionId)).toMatchObject({ state: "active", turnClaim: null });
    expect(store.validateTurnClaim(claim)).toBe(false);
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

  it("atomically fences a drained claim before its worker is reclaimed", async () => {
    const active = await advanceToActive();
    const workerClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-reclaim-claim",
      runId: "worker-reclaim-run",
    });
    const released = store.waitForTurnClaimRelease(SESSION.sessionId, { timeoutMs: 1_000 });

    const draining = await store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    await expect(
      store.fail({
        sessionId: SESSION.sessionId,
        expectedGeneration: draining.generation,
        recoveryError: "worker teardown not yet fenced",
      }),
    ).rejects.toThrow("Cannot fail worker session placement from draining");
    await expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "draining",
        to: "reclaimed",
        expectedGeneration: draining.generation,
      }),
    ).rejects.toThrow("Illegal worker session placement transition");
    await expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "draining",
        to: "reconciling",
        expectedGeneration: draining.generation,
      }),
    ).rejects.toThrow("Use startReconcile after fencing the drained worker environment");
    await expect(
      store.startReconcile({
        sessionId: SESSION.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: draining.generation - 1,
      }),
    ).rejects.toThrow("Cannot reconcile stale worker placement");
    const reconciling = await store.startReconcile({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    await expect(
      store.transition({
        sessionId: SESSION.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation - 1,
      }),
    ).rejects.toThrow("changed: expected reconciling");
    const reclaimed = await store.transition({
      sessionId: SESSION.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    expect(reclaimed).toMatchObject({ state: "reclaimed", turnClaim: null });
    await released;
    expect(store.validateTurnClaim(workerClaim)).toBe(false);
    expect(await store.startDispatch(SESSION)).toMatchObject({
      state: "requested",
      generation: reclaimed.generation + 1,
      environmentId: null,
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
    });
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

  it("advances the workspace manifest only under the exact worker turn claim", async () => {
    const active = await advanceToActive();
    const claim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "worker-workspace-claim",
      runId: "worker-workspace-run",
    });
    const manifestRef = `sha256:${"d".repeat(64)}`;

    expect(await store.updateWorkspaceBaseManifest({ claim, manifestRef })).toMatchObject({
      state: "active",
      workspaceBaseManifestRef: manifestRef,
    });
    await store.releaseTurn(claim);
    await expect(store.updateWorkspaceBaseManifest({ claim, manifestRef })).rejects.toThrow(
      "Cannot advance stale worker workspace",
    );
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

    expect(store.listPendingWorkspaceResults(SESSION.sessionId)).toMatchObject([
      { sessionId: SESSION.sessionId, claimId: claim.claimId, workspaceAcceptedAtMs: null },
    ]);
    expect(store.listPendingWorkspaceResults("other-session")).toEqual([]);
    expect(store.getWorkspaceResultReconcilingSessionIds([SESSION.sessionId])).toEqual(
      new Set([SESSION.sessionId]),
    );
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
    expect(store.listPendingWorkspaceResults(SESSION.sessionId)).toEqual([]);
    expect(store.getWorkspaceResultReconcilingSessionIds([SESSION.sessionId])).toEqual(new Set());
    expect(await store.getWorkspaceResultReconcilingSessionIdsAsync([SESSION.sessionId])).toEqual(
      new Set(),
    );
    expect(
      createWorkerSessionPlacementStore({ database, now: () => nowMs }).get(SESSION.sessionId),
    ).not.toHaveProperty("workspaceResultConflict");
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("preserves an admitted worker result while its placement is draining", async () => {
    const active = await advanceToActive();
    const claim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "draining-workspace-claim",
      runId: "draining-workspace-run",
    });
    const draining = await store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("expected draining workspace placement");
    }

    await store.markWorkspaceResultPending(claim);
    await expect(
      store.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      }),
    ).rejects.toThrow("pending cloud workspace result");

    const manifestRef = `sha256:${"d".repeat(64)}`;
    const basePack = Buffer.from("draining workspace base pack");
    const owner = {
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      placementGeneration: draining.generation,
    };
    await store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "a".repeat(32),
      baseManifestRef: draining.workspaceBaseManifestRef,
      currentManifestRef: manifestRef,
      baseEntries: [],
      appliedEntries: [],
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    expect(await store.loadWorkspaceReconciliation(owner)).toMatchObject({
      currentManifestRef: manifestRef,
    });
    expect(await store.updateWorkspaceBaseManifest({ claim, manifestRef })).toMatchObject({
      state: "draining",
      workspaceBaseManifestRef: manifestRef,
    });
    await store.acceptWorkspaceResult(claim);
    expect(await store.completeWorkspaceResultAndReleaseTurn(claim)).toMatchObject({
      state: "draining",
      turnClaim: null,
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
  });

  it("persists a workspace rollback journal and clears it with manifest acceptance", async () => {
    const active = await advanceToActive();
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const currentManifestRef = `sha256:${"c".repeat(64)}`;
    const content = Buffer.from("base");
    const basePack = Buffer.from("workspace base pack");
    // JavaScript UTF-16 and SQLite UTF-8 order these paths differently.
    const unicodePaths = ["\u{10000}.txt", "\uE000.txt"];
    await store.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "b".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef,
      baseEntries: unicodePaths.map((entryPath) => ({
        path: entryPath,
        type: "file",
        mode: 0o644,
        size: content.length,
        sha256: "d".repeat(64),
      })),
      appliedEntries: unicodePaths.map((entryPath) => ({
        path: entryPath,
        type: "file",
        mode: 0o644,
        size: 6,
        sha256: "e".repeat(64),
      })),
      baseTree: "f".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });

    await closeStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    expect(await store.listWorkspaceReconciliationOwners()).toEqual([owner]);
    const loaded = await store.loadWorkspaceReconciliation(owner);
    expect(loaded).toMatchObject({
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef,
    });
    expect(Buffer.from(loaded?.basePack ?? [])).toEqual(basePack);

    const claim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "journal-claim",
      runId: "journal-run",
    });
    await store.markWorkspaceResultPending(claim);
    const appliedManifestRef = active.workspaceBaseManifestRef;
    await store.updateWorkspaceBaseManifest({ claim, manifestRef: appliedManifestRef });
    expect(await store.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef,
    });
    await store.updateWorkspaceBaseManifest({ claim, manifestRef: currentManifestRef });
    expect(await store.loadWorkspaceReconciliation(owner)).toMatchObject({
      appliedManifestRef: currentManifestRef,
    });
    await store.acceptWorkspaceResult(claim);
    expect(await store.loadWorkspaceReconciliation(owner)).toBeUndefined();
  });
  it("filters reconciliation by exact session key across agents while preserving state and order", async () => {
    const localClaim = await store.claimTurn({
      ...SESSION,
      sessionId: "local",
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "local-run",
    });
    await store.releaseTurn(localClaim);
    const active = await advanceToActive({ ...SESSION, sessionId: "reclaimed" });
    const draining = await store.startDrain({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    await store.transition({
      sessionId: active.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    for (const [sessionId, sessionKey] of [
      ["unrelated-case", SESSION.sessionKey.toUpperCase()],
      ["unrelated-child", `${SESSION.sessionKey}:child`],
    ] as const) {
      await store.startDispatch({ ...SESSION, sessionId, sessionKey });
    }
    nowMs = 2_000;
    await advanceToActive({ ...SESSION, sessionId: "cross-agent", agentId: "other" });
    nowMs = 3_000;
    for (const sessionId of ["requested-z", "requested-a"]) {
      await store.startDispatch({ ...SESSION, sessionId });
    }
    nowMs = 4_000;
    await store.startDispatch({ ...SESSION, sessionId: "failed" });
    await store.fail({ sessionId: "failed", recoveryError: "dispatch failed" });

    expect(
      store.listForReconcile(SESSION.sessionKey).map(({ sessionId, state }) => [sessionId, state]),
    ).toEqual([
      ["cross-agent", "active"],
      ["requested-a", "requested"],
      ["requested-z", "requested"],
      ["failed", "failed"],
    ]);
    expect(store.listForReconcile().map((record) => record.sessionId)).toEqual([
      "unrelated-case",
      "unrelated-child",
      "cross-agent",
      "requested-a",
      "requested-z",
      "failed",
    ]);
    for (const sessionKey of ["agent:main:absent", "", ` ${SESSION.sessionKey} `]) {
      expect(store.listForReconcile(sessionKey)).toEqual([]);
    }
  });
});
