import { beforeEach, describe, expect, it } from "vitest";
import { WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { placementTurnOwner, type WorkerSessionTurnClaim } from "./placement-record.js";
import { usePlacementStoreFixture } from "./placement-store-fixture.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";

const ENVIRONMENT = { environmentId: "environment-worker-gate", ownerEpoch: 7 };
const BINDING = { sessionId: REQUEST.sessionId, ...ENVIRONMENT };
const OWNER = { kind: "worker", ...ENVIRONMENT } as const;

describe("worker session placement gate", () => {
  const fixture = usePlacementStoreFixture(undefined, undefined, Date.now);
  let database: typeof fixture.database;
  let store: typeof fixture.store;
  beforeEach(() => {
    ({ database, store } = fixture);
  });

  const activate = (executionMode: "worker-turn" | "remote-exec" = "worker-turn") =>
    advancePlacementFixtureToActive(store, database, { ...REQUEST, executionMode }, ENVIRONMENT);

  async function preclaim(runId: string, tools?: string[]) {
    await activate();
    const claim = await claimTurn(runId);
    if (tools) {
      await store.authorizeWorkerTurnTools(claim, tools);
    }
    return claim;
  }

  const claimTurn = (runId: string, owner: WorkerSessionTurnClaim["owner"] = OWNER) =>
    store.claimTurn({ ...REQUEST, claimId: `claim:${runId}`, runId, owner });
  const reclaim = (id: string) =>
    store.claimReclaimWorkspaceResult({ ...REQUEST, claimId: id, runId: id, owner: OWNER });
  const drain = (expectedGeneration: number) =>
    store.startDrain({ ...BINDING, expectedGeneration });
  const reconcile = (expectedGeneration: number) =>
    store.startReconcile({ ...BINDING, expectedGeneration });
  const operation = (claim: WorkerSessionTurnClaim, id: string) =>
    ({
      claim,
      toolName: "sessions_send",
      toolCallId: `call-${id}`,
      requestDigest: `digest-${id}`,
    }) as const;
  const complete = (claim: WorkerSessionTurnClaim, toolCallId: string, requestDigest: string) =>
    store.completeWorkerSessionToolOperation({
      sourceSessionId: claim.sessionId,
      sourceClaimId: claim.claimId,
      toolCallId,
      requestDigest,
      resultJson: '{"status":"ok"}',
    });

  it.each(["missing result", "live reclaim", "live turn", "move"] as const)(
    "rejects draining runtime refresh with %s",
    async (state) => {
      const active = await activate();
      const turn = state === "live turn" ? await claimTurn("live-turn") : undefined;
      if (state === "move") {
        await store.beginPlacementMove({
          sessionId: active.sessionId,
          source: { ...BINDING, generation: active.generation },
          target: { kind: "gateway" },
        });
      } else {
        await drain(active.generation);
      }
      if (turn) {
        await store.markWorkspaceResultPending(turn);
        await store.handoffWorkspaceResultRecovery(turn);
      } else if (state !== "missing result") {
        const claim = await reclaim("reclaim-gate");
        if (state === "move") {
          await store.handoffWorkspaceResultRecovery(claim);
        }
      }

      await expect(
        createWorkerSessionPlacementGate(store).prepareWorkerRuntimeRefresh(BINDING),
      ).rejects.toThrow("placement recovery owner");
    },
  );

  it.each(["metadata", "rollback", "handoff", "removal"] as const)(
    "retains exact Stop runtime refresh custody across %s changes",
    async (change) => {
      const active = await activate();
      await drain(active.generation);
      const claim = await reclaim("reclaim-refresh");
      await store.handoffWorkspaceResultRecovery(claim);
      const gate = createWorkerSessionPlacementGate(store);
      const refresh = await gate.prepareWorkerRuntimeRefresh(BINDING);
      if (change === "metadata") {
        sessionChanges.emit({ agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey });
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
    const claim = await preclaim("run-inherited-worker", ["sessions_send"]);
    await store.updateAckCursors({ claim, liveEvent: 1 });

    const restartedStore = createWorkerSessionPlacementStore({ database });
    const gate = createWorkerSessionPlacementGate(restartedStore, {
      recoveryPlacements: await restartedStore.listAsync(),
    });
    expect(restartedStore.validateTurnClaim(claim)).toBe(true);
    expect(await restartedStore.listPendingWorkspaceResultsAsync()).toMatchObject([
      { sessionId: claim.sessionId, claimId: claim.claimId },
    ]);
    expect(gate.validateWorkerTurn(claim)).toBe(false);
    expect(gate.readWorkerTurnClaim(BINDING)).toEqual(claim);
    expect(gate.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
    await expect(gate.updateAckCursors({ claim, transcriptSeq: 2 })).rejects.toThrow(
      "stale worker turn",
    );
    await expect(
      gate.prepareWorkspaceResultOwnerRevocation(BINDING, new Error("restart owner revoked")),
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
        recoveryPlacements: reused === "claim" ? await store.listAsync() : [],
      });
      if (reused === "claim") {
        expect(gate.validateWorkerTurn(first)).toBe(false);
      }
      await store.releaseTurn(first);
      const second = await store.claimTurn({
        ...REQUEST,
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
      const claim = await claimTurn("run-owner-revocation", placementTurnOwner(placement));
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
      await gate.prepareWorkspaceResultOwnerRevocation(BINDING, new Error(reason));
      const failed = mode === "remote-exec" && !staged;
      if (failed) {
        expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
      } else {
        expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
          {
            sessionId: claim.sessionId,
            recoveryRequestedAtMs: expect.any(Number),
            ...(staged ? { stagedResultRef } : {}),
          },
        ]);
      }
      expect(store.get(claim.sessionId)).toMatchObject({
        state: failed ? "failed" : "active",
        turnClaim: failed ? null : expect.anything(),
        ...(failed ? { recoveryError: reason } : {}),
      });
    },
  );

  it("lets the admitted worker finish acknowledgements after draining closes admission", async () => {
    const claim = await preclaim("run-worker-draining-ack");
    await drain(claim.placementGeneration);
    const gate = createWorkerSessionPlacementGate(store);
    expect(gate.validateWorkerTurn(claim)).toBe(true);
    await gate.updateAckCursors({ claim, transcriptSeq: 5 });
    expect(store.get(REQUEST.sessionId)?.lastTranscriptAckCursor).toBe(5);
    await store.releaseTurn(claim);
    expect(gate.validateWorkerTurn(claim)).toBe(false);
  });

  it("does not reconcile away a claim while its session operation is running", async () => {
    const claim = await preclaim("run-worker-reconcile-tools", ["sessions_send"]);
    const request = operation(claim, "reconcile-send");
    expect(await store.beginWorkerSessionToolOperation(request)).toMatchObject({ kind: "execute" });
    const draining = await drain(claim.placementGeneration);

    await expect(reconcile(draining.generation)).rejects.toThrow(
      "running worker session operation",
    );
    expect(store.get(claim.sessionId)).toMatchObject({
      state: "draining",
      turnClaim: { claimId: claim.claimId },
    });

    expect(await complete(claim, request.toolCallId, request.requestDigest)).toBe(true);
    expect(await reconcile(draining.generation)).toMatchObject({
      state: "reconciling",
      turnClaim: null,
    });
    for (const table of ["worker_turn_tool_authorities", "worker_session_tool_operations"]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
  });

  it("caps running session operations across connection incarnations", async () => {
    const claim = await preclaim("run-worker-tool-capacity", ["sessions_send"]);
    for (let index = 0; index < WORKER_PROTOCOL_MAX_CONCURRENT_TOOLS; index += 1) {
      expect(
        await store.beginWorkerSessionToolOperation(operation(claim, `capacity-${index}`)),
      ).toMatchObject({ kind: "execute" });
    }

    const reconnectedStore = createWorkerSessionPlacementStore({ database });
    expect(
      await reconnectedStore.beginWorkerSessionToolOperation(operation(claim, "capacity-overflow")),
    ).toEqual({ kind: "capacity" });
    expect(
      await store.beginWorkerSessionToolOperation(operation(claim, "capacity-0")),
    ).toMatchObject({ kind: "in-progress" });
  });

  it.each([false, true])("retains settlement owner (recovery: %s)", async (recover) => {
    const toolName = recover ? "sessions_send" : "sessions_spawn";
    const claim = await preclaim(
      "run-worker-restart",
      recover ? ["sessions_send"] : ["sessions_spawn", "sessions_send"],
    );
    const request = { ...operation(claim, "before-restart"), toolName } as const;
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
      expect(await complete(claim, request.toolCallId, request.requestDigest)).toBe(true);
      expect(await restarted.beginWorkerSessionToolOperation(request)).toEqual({
        kind: "completed",
        resultJson: '{"status":"ok"}',
      });
      await restarted.releaseTurn(claim);
    }
  });
});
