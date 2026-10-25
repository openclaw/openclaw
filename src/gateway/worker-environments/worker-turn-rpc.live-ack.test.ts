import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import {
  bindClaimOwner,
  claimTarget,
  seedClaim,
  turnRequests,
} from "./worker-turn-rpc-fixtures.test-support.js";

const ack = (ackedSeq: number) => ({ ok: true, result: { ackedSeq } });
const resync = (ackedSeq: number) => ({
  ok: false,
  details: { reason: "resync-required", ackedSeq, expectedSeq: ackedSeq + 1 },
});
const fenced = { ok: false, closeReason: "placement-mismatch" };

async function turnHarness(options: Parameters<typeof support.createService>[1] = {}) {
  const harness = await support.placementHarness("worker-ack", "session-ack", {
    applyTranscriptCommit: support.successfulTranscriptCommit("entry"),
    ...options,
  });
  return {
    ...harness,
    rpc: turnRequests(harness.identity, harness.workerService),
    cursors: () =>
      harness.placementStore.updateAckCursors.mock.calls.map(([{ transcriptSeq, liveSeq }]) => [
        transcriptSeq,
        liveSeq,
      ]),
  };
}

async function recoveredTurn(ackedSeq = 5) {
  const environmentId = "worker-recovered-live-ack";
  const sessionId = "session-recovered-live-ack";
  const previous = await seedClaim(environmentId, sessionId);
  await previous.store.updateAckCursors({ claim: previous.claim, liveEvent: ackedSeq });
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const placementStore = createWorkerSessionPlacementGate(placements, {
    recoveryPlacements: await placements.listAsync(),
  });
  expect(placementStore.validateWorkerTurn(previous.claim)).toBe(false);
  await placements.acceptWorkspaceResult(previous.claim);
  await placements.completeWorkspaceResultAndReleaseTurn(previous.claim);
  const target = claimTarget(sessionId);
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  const claim = await placements.claimTurn({
    ...target,
    claimId: "claim-after-recovery",
    runId: "run-after-recovery",
    owner: previous.claim.owner,
  });
  const owner = await bindClaimOwner(placements, claim, {
    target,
    beforeBind: (authority) => registerAgentRunContext(claim.runId, target, authority.claimId),
  });
  const liveEvents = createWorkerLiveEventReceiver();
  support.testState.releaseTurnOwners.push(() => {
    liveEvents.clear();
    owner.release();
  });
  const workerService = support.createService(support.createProvider(), {
    placementStore,
    liveEvents,
    applyTranscriptCommit: support.successfulTranscriptCommit("current-transcript"),
  });
  const credential = await workerService.acquireTurnCredential(claim);
  const identity = {
    ...previous.environmentIdentity,
    runId: claim.runId,
    turnClaim: claim,
    credentialHash: credential.deliveryId,
  };
  return { identity, placements, workerService };
}

describe("worker ACK ownership and ordering", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    { seq: 21, lastAckedSeq: 20, transcriptFirst: false },
    { seq: 5, lastAckedSeq: 5, transcriptFirst: true },
  ])(
    "withholds terminal authority for seq=$seq, transcriptFirst=$transcriptFirst",
    async ({ seq, lastAckedSeq, transcriptFirst }) => {
      const { identity, placements, workerService } = await recoveredTurn();
      const rpc = turnRequests(identity, workerService);
      if (transcriptFirst) {
        await expect(rpc.transcript("current")).resolves.toMatchObject({ ok: true });
      }
      await expect(rpc.terminal({ seq, lastAckedSeq })).resolves.toEqual(
        lastAckedSeq > 5 ? resync(5) : ack(5),
      );
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(5);
      if (lastAckedSeq === 5) {
        await expect(rpc.assistant("still active", { seq: 6, lastAckedSeq: 5 })).resolves.toEqual(
          ack(6),
        );
      }
    },
  );

  it("discards buffered terminal authority when the receiver requests resync", async () => {
    const { identity, placements, workerService } = await recoveredTurn();
    const rpc = turnRequests(identity, workerService);
    await expect(rpc.terminal({ seq: 7, lastAckedSeq: 5 })).resolves.toEqual(ack(5));
    await expect(rpc.assistant("resync", { seq: 6, lastAckedSeq: 6 })).resolves.toEqual(resync(5));
    for (const seq of [6, 7]) {
      await expect(rpc.assistant("replayed", { seq, lastAckedSeq: seq - 1 })).resolves.toEqual(
        ack(seq),
      );
    }
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    await expect(rpc.terminal({ seq: 8, lastAckedSeq: 7 })).resolves.toEqual(ack(8));
    expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(8);
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
  });
  it.each(["transcript", "terminal"] as const)(
    "does not return a successful %s ACK when persistence rejects",
    async (kind) => {
      const { placementStore, rpc } = await turnHarness({
        liveEvents: support.sequencedLiveEvents().liveEvents,
      });
      const error = new Error("ACK persistence refused");
      placementStore.updateAckCursors.mockRejectedValueOnce(error);
      const request = () => (kind === "transcript" ? rpc.transcript("retry") : rpc.terminal());
      await expect(request()).rejects.toBe(error);
      await expect(request()).resolves.toMatchObject({ ok: true });
      expect(placementStore.updateAckCursors).toHaveBeenCalledTimes(2);
    },
  );

  it("advances the transcript cursor when a stale-base commit consumes its sequence", async () => {
    const applyTranscriptCommit = vi
      .fn<NonNullable<support.WorkerEnvironmentServiceOptions["applyTranscriptCommit"]>>()
      .mockImplementationOnce(async ({ onCommitted }) => {
        const outcome = { ok: false as const, reason: "stale-base-leaf" as const };
        await onCommitted?.(outcome);
        return outcome;
      })
      .mockResolvedValueOnce({ ok: false, reason: "invalid-batch" });
    const { cursors, rpc } = await turnHarness({ applyTranscriptCommit });

    await expect(rpc.transcript("stale", { seq: 11, baseLeafId: "stale-leaf" })).resolves.toEqual({
      ok: false,
      reason: "stale-base-leaf",
    });
    await expect(rpc.transcript("stale", { seq: 12, baseLeafId: "stale-leaf" })).resolves.toEqual({
      ok: false,
      reason: "invalid-batch",
    });
    expect(cursors()).toEqual([[11, undefined]]);
  });

  it("fences after a buffered terminal event becomes acknowledged by a gap fill", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-terminal-gap");
    const { apply, liveEvents } = support.sequencedLiveEvents((seq) => (seq === 1 ? 2 : 0));
    const { placementStore, cursors, rpc } = await turnHarness({
      applyTranscriptCommit,
      liveEvents,
    });

    await expect(rpc.terminal({ seq: 2 })).resolves.toEqual(ack(0));
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    await expect(rpc.assistant("fills gap")).resolves.toEqual(ack(2));
    expect(cursors()).toEqual([[undefined, 2]]);
    await expect(rpc.transcript("late transcript")).resolves.toEqual(fenced);
    await expect(rpc.assistant("late", { lastAckedSeq: 2, seq: 3 })).resolves.toEqual(fenced);
    expect(applyTranscriptCommit).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("holds terminal events behind transcript commit and delayed durable ACK settlement", async () => {
    const commitStarted = createDeferredCore();
    const { promise: commitBlocked, resolve: finishCommit } = createDeferredCore();
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-order", () => {
      commitStarted.resolve();
      return commitBlocked;
    });
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents();
    const { placementStore, cursors, rpc } = await turnHarness({
      applyTranscriptCommit,
      liveEvents,
    });
    const ackStarted = createDeferredCore();
    const ackSettled = createDeferredCore();
    placementStore.updateAckCursors.mockImplementationOnce(async () => {
      ackStarted.resolve();
      await ackSettled.promise;
    });

    const commit = rpc.transcript("commit before terminal");
    await commitStarted.promise;
    const terminal = rpc.terminal();
    await Promise.resolve();
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    finishCommit?.();
    await ackStarted.promise;
    expect(liveApply).not.toHaveBeenCalled();
    ackSettled.resolve();
    await expect(commit).resolves.toMatchObject({ ok: true });
    await expect(terminal).resolves.toEqual(ack(1));
    expect(cursors()).toEqual([
      [1, undefined],
      [undefined, 1],
    ]);
  });
});
