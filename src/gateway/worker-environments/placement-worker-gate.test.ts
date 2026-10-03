import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import { MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS } from "./placement-session-tool-operations.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-worker-gate",
  agentId: "main",
  sessionKey: "agent:main:worker-gate",
};
const ENVIRONMENT_ID = "environment-worker-gate";
const OWNER_EPOCH = 7;

describe("worker session placement gate", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;

  beforeEach(() => {
    root = tempDirs.make("openclaw-worker-gate-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerSessionPlacementStore({ database });
  });

  function activate(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
    return advancePlacementFixtureToActive(
      store,
      database,
      { ...SESSION, executionMode },
      {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        workspaceBaseManifestRef: "manifest-worker-gate",
        remoteWorkspaceDir: "/workspace/worker-gate",
      },
    );
  }

  async function preclaim(runId: string) {
    const placement = await activate();
    return store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: `claim:${runId}`,
      runId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
  }

  function bindingFor(claim: Awaited<ReturnType<typeof preclaim>>) {
    return claim;
  }

  it("rejects an identical claim readmitted while runtime refresh hands off its result", async () => {
    const claim = await preclaim("run-refresh-handoff");
    store.markWorkspaceResultPending(claim);
    const gate = createWorkerSessionPlacementGate(store, { rejectExistingWorkerClaims: true });
    const handoff = store.handoffRuntimeRefreshResult.bind(store);
    vi.spyOn(store, "handoffRuntimeRefreshResult").mockImplementationOnce(async (...args) => {
      const placement = await handoff(...args);
      store.acceptWorkspaceResult(claim);
      store.completeWorkspaceResultAndReleaseTurn(claim);
      const replacement = await store.claimTurn({ ...SESSION, ...claim });
      store.markWorkspaceResultPending(replacement);
      store.handoffWorkspaceResultRecovery(replacement);
      return placement;
    });

    await expect(
      gate.prepareWorkerRuntimeRefresh({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
      }),
    ).rejects.toThrow("turn recovery owner");
    expect(store.validateTurnClaim(claim)).toBe(true);
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { claimId: claim.claimId, recoveryRequestedAtMs: expect.any(Number) },
    ]);
  });

  it.each(["missing result", "live reclaim", "live turn", "move"] as const)(
    "rejects draining runtime refresh with %s",
    async (state) => {
      const active = await activate();
      const binding = {
        sessionId: active.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
      };
      const turn =
        state === "live turn"
          ? await store.claimTurn({
              ...SESSION,
              claimId: "claim:live-turn",
              runId: "live-turn",
              owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
            })
          : undefined;
      if (state === "move") {
        store.beginPlacementMove({
          sessionId: active.sessionId,
          source: { ...binding, generation: active.generation },
          target: { kind: "gateway" },
        });
      } else {
        store.startDrain({ ...binding, expectedGeneration: active.generation });
      }
      if (turn) {
        store.markWorkspaceResultPending(turn);
        store.handoffWorkspaceResultRecovery(turn);
      } else if (state !== "missing result") {
        const claim = store.claimReclaimWorkspaceResult({
          ...SESSION,
          claimId: "reclaim-gate",
          runId: "reclaim-gate",
          owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
        });
        if (state === "move") {
          store.handoffWorkspaceResultRecovery(claim);
        }
      }

      await expect(
        createWorkerSessionPlacementGate(store).prepareWorkerRuntimeRefresh(binding),
      ).rejects.toThrow("placement recovery owner");
    },
  );

  it.each(["metadata", "rollback", "handoff", "removal"] as const)(
    "retains exact Stop runtime refresh custody across %s changes",
    async (change) => {
      const active = await activate();
      const binding = {
        sessionId: active.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
      };
      store.startDrain({ ...binding, expectedGeneration: active.generation });
      const claim = store.claimReclaimWorkspaceResult({
        ...SESSION,
        claimId: "reclaim-refresh",
        runId: "reclaim-refresh",
        owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      });
      store.handoffWorkspaceResultRecovery(claim);
      const gate = createWorkerSessionPlacementGate(store);
      const refresh = await gate.prepareWorkerRuntimeRefresh(binding);
      if (change === "metadata") {
        sessionChanges.emit({ agentId: SESSION.agentId, sessionKey: SESSION.sessionKey });
        expect(() => refresh.assertCurrent()).not.toThrow();
      } else if (change === "rollback") {
        expect(() =>
          runOpenClawStateWriteTransaction(
            () => {
              store.handoffWorkspaceResultRecovery(claim);
              expect(() => refresh.assertCurrent()).toThrow("placement authority changed");
              throw new Error("rollback recovery handoff");
            },
            { path: database.path },
          ),
        ).toThrow("rollback recovery handoff");
        expect(() => refresh.assertCurrent()).not.toThrow();
      } else {
        if (change === "handoff") {
          store.handoffWorkspaceResultRecovery(claim);
        } else {
          store.abandonWorkspaceResult(store.listPendingWorkspaceResults()[0]!);
        }
        expect(() => refresh.assertCurrent()).toThrow("placement authority changed");
      }
      refresh.release();

      expect(gate.validateWorkerTurn(claim)).toBe(false);
      expect(store.validateWorkspaceResultClaim(claim)).toBe(change !== "removal");
    },
  );

  it("rejects restart-inherited claims while preserving workspace recovery authority", async () => {
    const claim = await preclaim("run-inherited-worker");
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    await store.updateAckCursors({ claim, liveEvent: 1 });

    const restartedStore = createWorkerSessionPlacementStore({ database });
    const gate = createWorkerSessionPlacementGate(restartedStore, {
      rejectExistingWorkerClaims: true,
    });
    const binding = {
      sessionId: claim.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
    };

    expect(restartedStore.validateTurnClaim(claim)).toBe(true);
    expect(restartedStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
    expect(gate.validateWorkerTurn(claim)).toBe(false);
    expect(gate.readWorkerTurnClaim(binding)).toEqual(claim);
    expect(gate.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
    await expect(gate.updateAckCursors({ claim, transcriptSeq: 2 })).rejects.toThrow(
      "stale worker turn",
    );
    expect(() =>
      gate.prepareWorkspaceResultOwnerRevocation(binding, new Error("restart owner revoked")),
    ).not.toThrow();
    expect(restartedStore.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: claim.sessionId, recoveryRequestedAtMs: null },
    ]);
  });

  it("does not classify a same-id claim from a different run as inherited", async () => {
    const first = await preclaim("run-inherited-a");
    const gate = createWorkerSessionPlacementGate(store, {
      rejectExistingWorkerClaims: true,
    });
    expect(gate.validateWorkerTurn(first)).toBe(false);
    await store.releaseTurn(first);
    const placement = store.get(SESSION.sessionId)!;
    const second = await store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: first.claimId,
      runId: "run-current-b",
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });

    expect(gate.validateWorkerTurn(second)).toBe(true);
  });

  it("fences a replaced exact claim when the durable run id is reused", async () => {
    const runId = "run-reused-worker";
    const first = await preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const firstBinding = bindingFor(first);
    await store.releaseTurn(first);
    const placement = store.get(SESSION.sessionId)!;
    const second = await store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim:replacement",
      runId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    const secondBinding = bindingFor(second);
    await store.authorizeWorkerTurnTools(second, ["sessions_send"]);

    expect(gate.validateWorkerTurn(firstBinding)).toBe(false);
    expect(gate.validateWorkerTurn(secondBinding)).toBe(true);
    expect(() => gate.readWorkerTurnLiveAckCursor(firstBinding)).toThrow("stale worker turn");
    expect(gate.readWorkerTurnLiveAckCursor(secondBinding)).toBe(0);
    expect(gate.isWorkerTurnToolAuthorized(firstBinding, "sessions_send")).toBe(false);
    expect(gate.isWorkerTurnToolAuthorized(secondBinding, "sessions_send")).toBe(true);
    await expect(gate.updateAckCursors({ claim: firstBinding, transcriptSeq: 3 })).rejects.toThrow(
      "stale worker turn",
    );
  });

  it("atomically retains the finishing cursor and workspace-result fence", async () => {
    const runId = "run-worker-ack";
    const claim = await preclaim(runId);
    const gate = createWorkerSessionPlacementGate(store);
    const binding = bindingFor(claim);

    await gate.updateAckCursors({ claim: binding, transcriptSeq: 4 });
    expect(store.listPendingWorkspaceResults()).toEqual([]);
    await gate.updateAckCursors({ claim: binding, liveSeq: 9 });
    expect(store.get(SESSION.sessionId)).toMatchObject({
      generation: claim.placementGeneration,
      lastTranscriptAckCursor: 4,
      lastLiveEventAckCursor: 9,
    });
    expect(gate.readWorkerTurnLiveAckCursor(binding)).toBe(9);
    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: SESSION.sessionId, runId },
    ]);
    store.acceptWorkspaceResult(claim);
    store.completeWorkspaceResultAndReleaseTurn(claim);
    expect(store.get(SESSION.sessionId)?.turnClaim).toBeNull();
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("hands a worker-owned pending result to recovery before owner revocation", async () => {
    const claim = await preclaim("run-worker-revoked");
    const gate = createWorkerSessionPlacementGate(store);
    await gate.updateAckCursors({ claim, liveSeq: 1 });

    gate.prepareWorkspaceResultOwnerRevocation(
      { sessionId: claim.sessionId, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      new Error("worker owner revoked"),
    );

    expect(store.listPendingWorkspaceResults()).toMatchObject([
      { sessionId: claim.sessionId, recoveryRequestedAtMs: expect.any(Number) },
    ]);
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "active",
      turnClaim: expect.anything(),
    });
  });

  it("fails a Gateway-owned pending result before owner revocation", async () => {
    const placement = await activate("remote-exec");
    const claim = await store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim:run-local-revoked",
      runId: "run-local-revoked",
      owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    store.markWorkspaceResultPending(claim);

    createWorkerSessionPlacementGate(store).prepareWorkspaceResultOwnerRevocation(
      { sessionId: claim.sessionId, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      new Error("local owner revoked"),
    );

    expect(store.listPendingWorkspaceResults()).toEqual([]);
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "failed",
      recoveryError: "local owner revoked",
      turnClaim: null,
    });
  });

  it("preserves a staged Gateway-owned result during owner revocation", async () => {
    const placement = await activate("remote-exec");
    const claim = await store.claimTurn({
      sessionId: placement.sessionId,
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      claimId: "claim:run-local-staged",
      runId: "run-local-staged",
      owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
    });
    store.markWorkspaceResultPending(claim);
    await store.recordStagedWorkspaceResult(claim, "refs/openclaw/worker-results/local-staged");

    createWorkerSessionPlacementGate(store).prepareWorkspaceResultOwnerRevocation(
      { sessionId: claim.sessionId, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      new Error("local owner revoked"),
    );

    expect(store.listPendingWorkspaceResults()).toMatchObject([
      {
        sessionId: claim.sessionId,
        recoveryRequestedAtMs: expect.any(Number),
        stagedResultRef: "refs/openclaw/worker-results/local-staged",
      },
    ]);
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "active",
      turnClaim: expect.anything(),
    });
  });

  it("lets the admitted worker finish acknowledgements after draining closes admission", async () => {
    const runId = "run-worker-draining-ack";
    const claim = await preclaim(runId);
    const active = store.get(SESSION.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const gate = createWorkerSessionPlacementGate(store);
    const binding = bindingFor(claim);

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    await gate.updateAckCursors({ claim: binding, transcriptSeq: 5 });
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBe(5);
    await store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("drains running session-tool operations before revoking their durable state", async () => {
    const claim = await preclaim("run-worker-tools");
    const binding = bindingFor(claim);
    await store.authorizeWorkerTurnTools(claim, ["sessions_spawn"]);

    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(true);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_send")).toBe(false);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toMatchObject({
      kind: "execute",
      operationSeed: expect.any(String),
    });
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
      }),
    ).toEqual({ kind: "in-progress" });
    const closing = store.closeWorkerTurnToolState(claim);
    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(false);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-after-close",
        requestDigest: "digest-after-close",
      }),
    ).toEqual({ kind: "unauthorized" });

    expect(
      await store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-spawn",
        requestDigest: "digest-one",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    await closing;
    await store.releaseTurn(claim);

    expect(store.isWorkerTurnToolAuthorized(binding, "sessions_spawn")).toBe(false);
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_turn_tool_authorities").get(),
    ).toEqual({ count: 0 });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_session_tool_operations").get(),
    ).toEqual({ count: 0 });
  });

  it("does not reconcile away a claim while its session operation is running", async () => {
    const claim = await preclaim("run-worker-reconcile-tools");
    const binding = bindingFor(claim);
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-reconcile-send",
        requestDigest: "digest-reconcile-send",
      }),
    ).toMatchObject({ kind: "execute" });
    const draining = store.startDrain({
      sessionId: claim.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      expectedGeneration: claim.placementGeneration,
    });

    expect(() =>
      store.startReconcile({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        expectedGeneration: draining.generation,
      }),
    ).toThrow("running worker session operation");
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId },
    });

    expect(
      await store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-reconcile-send",
        requestDigest: "digest-reconcile-send",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(
      store.startReconcile({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        expectedGeneration: draining.generation,
      }),
    ).toMatchObject({ state: "reconciling", turnClaim: null });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_turn_tool_authorities").get(),
    ).toEqual({ count: 0 });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM worker_session_tool_operations").get(),
    ).toEqual({ count: 0 });
  });

  it("caps running session operations across connection incarnations", async () => {
    const claim = await preclaim("run-worker-tool-capacity");
    const binding = bindingFor(claim);
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    for (let index = 0; index < MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS; index += 1) {
      expect(
        await store.beginWorkerSessionToolOperation({
          claim: binding,
          toolName: "sessions_send",
          toolCallId: `capacity-call-${index}`,
          requestDigest: `capacity-digest-${index}`,
        }),
      ).toMatchObject({ kind: "execute" });
    }

    const reconnectedStore = createWorkerSessionPlacementStore({ database });
    expect(
      await reconnectedStore.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "capacity-overflow",
        requestDigest: "capacity-overflow-digest",
      }),
    ).toEqual({ kind: "capacity" });
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "capacity-call-0",
        requestDigest: "capacity-digest-0",
      }),
    ).toMatchObject({ kind: "in-progress" });
  });

  it("does not let a foreign store steal a live operation fence", async () => {
    const claim = await preclaim("run-worker-restart");
    const binding = bindingFor(claim);
    await store.authorizeWorkerTurnTools(claim, ["sessions_spawn", "sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(
      await restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "changed-digest",
      }),
    ).toEqual({ kind: "conflict" });
    await expect(restarted.releaseTurn(claim)).rejects.toThrow("running worker session operation");
    expect(
      await store.completeWorkerSessionToolOperation({
        sourceSessionId: claim.sessionId,
        sourceClaimId: claim.claimId,
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
        resultJson: '{"status":"ok"}',
      }),
    ).toBe(true);
    expect(
      await restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_spawn",
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      }),
    ).toEqual({ kind: "completed", resultJson: '{"status":"ok"}' });
    await restarted.releaseTurn(claim);
  });

  it("makes crash-ambiguous operations terminal before restart reconciliation", async () => {
    const claim = await preclaim("run-worker-crash-recovery");
    const binding = bindingFor(claim);
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toMatchObject({ kind: "execute" });

    const restarted = createWorkerSessionPlacementStore({ database });
    expect(await restarted.recoverWorkerSessionToolOperationsAfterRestart()).toBe(1);
    expect(
      await restarted.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-before-crash",
        requestDigest: "digest-before-crash",
      }),
    ).toEqual({ kind: "unknown" });
    await expect(restarted.releaseTurn(claim)).resolves.toBeDefined();
  });
});
