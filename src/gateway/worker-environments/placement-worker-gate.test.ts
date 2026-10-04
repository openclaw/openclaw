import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
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

  it("rejects an identical claim readmitted while runtime refresh hands off its result", async () => {
    const claim = await preclaim("run-refresh-handoff");
    await store.markWorkspaceResultPending(claim);
    const gate = createWorkerSessionPlacementGate(store, { rejectExistingWorkerClaims: true });
    const handoff = store.handoffRuntimeRefreshResult.bind(store);
    vi.spyOn(store, "handoffRuntimeRefreshResult").mockImplementationOnce(async (...args) => {
      const placement = await handoff(...args);
      await store.acceptWorkspaceResult(claim);
      await store.completeWorkspaceResultAndReleaseTurn(claim);
      const replacement = await store.claimTurn({ ...SESSION, ...claim });
      await store.markWorkspaceResultPending(replacement);
      await store.handoffWorkspaceResultRecovery(replacement);
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
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
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
        await store.startDrain({ ...binding, expectedGeneration: active.generation });
      }
      if (turn) {
        await store.markWorkspaceResultPending(turn);
        await store.handoffWorkspaceResultRecovery(turn);
      } else if (state !== "missing result") {
        const claim = await store.claimReclaimWorkspaceResult({
          ...SESSION,
          claimId: "reclaim-gate",
          runId: "reclaim-gate",
          owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
        });
        if (state === "move") {
          await store.handoffWorkspaceResultRecovery(claim);
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
      await store.startDrain({ ...binding, expectedGeneration: active.generation });
      const claim = await store.claimReclaimWorkspaceResult({
        ...SESSION,
        claimId: "reclaim-refresh",
        runId: "reclaim-refresh",
        owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      });
      await store.handoffWorkspaceResultRecovery(claim);
      const gate = createWorkerSessionPlacementGate(store);
      const refresh = await gate.prepareWorkerRuntimeRefresh(binding);
      if (change === "metadata") {
        sessionChanges.emit({ agentId: SESSION.agentId, sessionKey: SESSION.sessionKey });
        expect(() => refresh.assertCurrent()).not.toThrow();
      } else if (change === "rollback") {
        database.db.exec(`
          CREATE TRIGGER reject_recovery_handoff
          BEFORE UPDATE OF recovery_requested_at_ms ON worker_workspace_pending_results
          BEGIN
            SELECT RAISE(ABORT, 'rollback recovery handoff');
          END;
        `);
        await expect(store.handoffWorkspaceResultRecovery(claim)).rejects.toThrow(
          "rollback recovery handoff",
        );
        expect(() => refresh.assertCurrent()).not.toThrow();
      } else {
        if (change === "handoff") {
          await store.handoffWorkspaceResultRecovery(claim);
        } else {
          await store.abandonWorkspaceResult((await store.listPendingWorkspaceResultsAsync())[0]!);
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
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
    expect(gate.validateWorkerTurn(claim)).toBe(false);
    expect(gate.readWorkerTurnClaim(binding)).toEqual(claim);
    expect(gate.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
    await expect(gate.updateAckCursors({ claim, transcriptSeq: 2 })).rejects.toThrow(
      "stale worker turn",
    );
    await expect(
      gate.prepareWorkspaceResultOwnerRevocation(binding, new Error("restart owner revoked")),
    ).resolves.toBeUndefined();
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: claim.sessionId, recoveryRequestedAtMs: null },
    ]);
  });

  it.each(["claim", "run"] as const)(
    "fences the predecessor when a successor reuses its %s ID",
    async (reused) => {
      const first = await preclaim("run-inherited");
      const gate = createWorkerSessionPlacementGate(store, {
        rejectExistingWorkerClaims: reused === "claim",
      });
      if (reused === "claim") {
        expect(gate.validateWorkerTurn(first)).toBe(false);
      }
      await store.releaseTurn(first);
      const second = await store.claimTurn({
        ...SESSION,
        claimId: reused === "claim" ? first.claimId : "claim:replacement",
        runId: reused === "run" ? first.runId : "run-current",
        owner: first.owner,
      });
      await store.authorizeWorkerTurnTools(second, ["sessions_send"]);
      expect(gate.validateWorkerTurn(first)).toBe(false);
      expect(gate.validateWorkerTurn(second)).toBe(true);
      expect(() => gate.readWorkerTurnLiveAckCursor(first)).toThrow("stale worker turn");
      expect(gate.readWorkerTurnLiveAckCursor(second)).toBe(0);
      expect(gate.isWorkerTurnToolAuthorized(first, "sessions_send")).toBe(false);
      expect(gate.isWorkerTurnToolAuthorized(second, "sessions_send")).toBe(true);
      await expect(gate.updateAckCursors({ claim: first, transcriptSeq: 3 })).rejects.toThrow(
        "stale worker turn",
      );
    },
  );

  it.each([
    { mode: "worker-turn", staged: false },
    { mode: "remote-exec", staged: false },
    { mode: "remote-exec", staged: true },
  ] as const)(
    "settles $mode pending results before owner revocation (staged: $staged)",
    async ({ mode, staged }) => {
      const placement = await activate(mode);
      const claim = await store.claimTurn({
        ...SESSION,
        claimId: "claim:owner-revocation",
        runId: "run-owner-revocation",
        owner: placementTurnOwner(placement),
      });
      const gate = createWorkerSessionPlacementGate(store);
      if (mode === "worker-turn") {
        await gate.updateAckCursors({ claim, liveSeq: 1 });
      } else {
        await store.markWorkspaceResultPending(claim);
      }
      const stagedResultRef = "refs/openclaw/worker-results/local-staged";
      if (staged) {
        await store.recordStagedWorkspaceResult(claim, stagedResultRef);
      }
      const reason = mode === "worker-turn" ? "worker owner revoked" : "local owner revoked";
      await gate.prepareWorkspaceResultOwnerRevocation(
        { sessionId: claim.sessionId, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
        new Error(reason),
      );
      if (mode === "remote-exec" && !staged) {
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(store.get(claim.sessionId)).toMatchObject({
          state: "failed",
          recoveryError: reason,
          turnClaim: null,
        });
      } else {
        expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
          {
            sessionId: claim.sessionId,
            recoveryRequestedAtMs: expect.any(Number),
            ...(staged ? { stagedResultRef } : {}),
          },
        ]);
        expect(store.get(claim.sessionId)).toMatchObject({
          state: "active",
          turnClaim: expect.anything(),
        });
      }
    },
  );

  it("lets the admitted worker finish acknowledgements after draining closes admission", async () => {
    const runId = "run-worker-draining-ack";
    const claim = await preclaim(runId);
    const active = store.get(SESSION.sessionId);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    await store.startDrain({
      sessionId: SESSION.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const gate = createWorkerSessionPlacementGate(store);
    const binding = claim;

    expect(gate.validateWorkerTurn(binding)).toBe(true);
    await gate.updateAckCursors({ claim: binding, transcriptSeq: 5 });
    expect(store.get(SESSION.sessionId)?.lastTranscriptAckCursor).toBe(5);
    await store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(binding)).toBe(false);
  });

  it("does not reconcile away a claim while its session operation is running", async () => {
    const claim = await preclaim("run-worker-reconcile-tools");
    const binding = claim;
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    expect(
      await store.beginWorkerSessionToolOperation({
        claim: binding,
        toolName: "sessions_send",
        toolCallId: "call-reconcile-send",
        requestDigest: "digest-reconcile-send",
      }),
    ).toMatchObject({ kind: "execute" });
    const draining = await store.startDrain({
      sessionId: claim.sessionId,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      expectedGeneration: claim.placementGeneration,
    });

    await expect(
      store.startReconcile({
        sessionId: claim.sessionId,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        expectedGeneration: draining.generation,
      }),
    ).rejects.toThrow("running worker session operation");
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
      await store.startReconcile({
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
    const binding = claim;
    await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
    for (let index = 0; index < WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS; index += 1) {
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

  it.each([false, true])(
    "reserves operation settlement for its owner until restart recovery: %s",
    async (recover) => {
      const claim = await preclaim("run-worker-restart");
      const toolName = recover ? "sessions_send" : "sessions_spawn";
      await store.authorizeWorkerTurnTools(
        claim,
        recover ? ["sessions_send"] : ["sessions_spawn", "sessions_send"],
      );
      const request = {
        claim,
        toolName,
        toolCallId: "call-before-restart",
        requestDigest: "digest-before-restart",
      } as const;
      expect(await store.beginWorkerSessionToolOperation(request)).toMatchObject({
        kind: "execute",
      });
      const restarted = createWorkerSessionPlacementStore({ database });
      if (recover) {
        expect(await restarted.recoverWorkerSessionToolOperationsAfterRestart()).toBe(1);
      }
      expect(await restarted.beginWorkerSessionToolOperation(request)).toEqual({ kind: "unknown" });
      if (recover) {
        await expect(restarted.releaseTurn(claim)).resolves.toBeDefined();
      } else {
        expect(
          await restarted.beginWorkerSessionToolOperation({
            ...request,
            requestDigest: "changed-digest",
          }),
        ).toEqual({ kind: "conflict" });
        await expect(restarted.releaseTurn(claim)).rejects.toThrow(
          "running worker session operation",
        );
        expect(
          await store.completeWorkerSessionToolOperation({
            sourceSessionId: claim.sessionId,
            sourceClaimId: claim.claimId,
            toolCallId: request.toolCallId,
            requestDigest: request.requestDigest,
            resultJson: '{"status":"ok"}',
          }),
        ).toBe(true);
        expect(await restarted.beginWorkerSessionToolOperation(request)).toEqual({
          kind: "completed",
          resultJson: '{"status":"ok"}',
        });
        await restarted.releaseTurn(claim);
      }
    },
  );
});
