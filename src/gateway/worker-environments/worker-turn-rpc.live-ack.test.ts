import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";

async function recoveredTurn(ackedSeq = 5) {
  const environmentId = "worker-recovered-live-ack";
  const sessionId = "session-recovered-live-ack";
  const previousIdentity = await support.seedAttachedIdentity(environmentId, sessionId);
  const previous = await claimWorkerPlacement({
    environmentId,
    ownerEpoch: previousIdentity.ownerEpoch,
    sessionId,
  });
  await previous.store.updateAckCursors({ claim: previous.claim, liveEvent: ackedSeq });
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const placementStore = createWorkerSessionPlacementGate(placements, {
    rejectExistingWorkerClaims: true,
  });
  expect(placementStore.validateWorkerTurn(previous.claim)).toBe(false);
  await placements.acceptWorkspaceResult(previous.claim);
  await placements.completeWorkspaceResultAndReleaseTurn(previous.claim);
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(support.testState.root, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  const claim = await placements.claimTurn({
    ...target,
    claimId: "claim-after-recovery",
    runId: "run-after-recovery",
    owner: previous.claim.owner,
  });
  const instance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(instance);
  registerAgentRunContext(claim.runId, target, authority.claimId);
  await bindWorkerTurnOwner(placements, claim, undefined, instance, target, () => undefined);
  const liveEvents = createWorkerLiveEventReceiver();
  support.testState.releaseTurnOwners.push(() => {
    liveEvents.clear();
    releaseAgentRunDelegatedAuthority(authority);
  });
  const workerService = support.createService(support.createProvider(), {
    placementStore,
    liveEvents,
    applyTranscriptCommit: support.successfulTranscriptCommit("current-transcript"),
  });
  const credential = await workerService.acquireTurnCredential(claim);
  const identity = {
    ...previousIdentity,
    runId: claim.runId,
    turnClaim: claim,
    credentialHash: credential.deliveryId,
  };
  return { identity, placements, workerService };
}

describe("worker live ACK ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    { ackedSeq: 0, seq: 21, lastAckedSeq: 20, transcriptFirst: false },
    { ackedSeq: 5, seq: 21, lastAckedSeq: 20, transcriptFirst: false },
    { ackedSeq: 5, seq: 5, lastAckedSeq: 5, transcriptFirst: false },
    { ackedSeq: 5, seq: 5, lastAckedSeq: 5, transcriptFirst: true },
  ])(
    "withholds terminal authority for seq=$seq, durable=$ackedSeq, transcriptFirst=$transcriptFirst",
    async ({ ackedSeq, seq, lastAckedSeq, transcriptFirst }) => {
      const { identity, placements, workerService } = await recoveredTurn(ackedSeq);
      if (transcriptFirst) {
        await expect(
          workerService.commitTranscript(identity, support.transcriptRequest(identity, "current")),
        ).resolves.toMatchObject({ ok: true });
      }
      await expect(
        workerService.pushLiveEvent(
          identity,
          support.terminalEvent(identity, { seq, lastAckedSeq }),
        ),
      ).resolves.toEqual(
        lastAckedSeq > ackedSeq
          ? {
              ok: false,
              details: { reason: "resync-required", ackedSeq, expectedSeq: ackedSeq + 1 },
            }
          : { ok: true, result: { ackedSeq } },
      );
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(ackedSeq);
      if (lastAckedSeq === ackedSeq) {
        await expect(
          workerService.pushLiveEvent(
            identity,
            support.assistantEvent(identity, "still active", { seq: 6, lastAckedSeq: 5 }),
          ),
        ).resolves.toEqual({ ok: true, result: { ackedSeq: 6 } });
      }
    },
  );

  it("discards buffered terminal authority when the receiver requests resync", async () => {
    const { identity, placements, workerService } = await recoveredTurn();
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { seq: 7, lastAckedSeq: 5 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 5 } });
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.assistantEvent(identity, "resync", { seq: 6, lastAckedSeq: 6 }),
      ),
    ).resolves.toEqual({
      ok: false,
      details: { reason: "resync-required", ackedSeq: 5, expectedSeq: 6 },
    });
    for (const seq of [6, 7]) {
      await expect(
        workerService.pushLiveEvent(
          identity,
          support.assistantEvent(identity, "replayed", { seq, lastAckedSeq: seq - 1 }),
        ),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: seq } });
    }
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { seq: 8, lastAckedSeq: 7 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 8 } });
    expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(8);
    expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
  });
});

type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;

describe("worker ACK ordering", () => {
  support.setupWorkerEnvironmentServiceSuite({ reuseReadWorkers: true });

  it.each(["transcript", "terminal"] as const)(
    "does not return a successful %s ACK when persistence rejects",
    async (kind) => {
      const { liveEvents } = support.sequencedLiveEvents();
      const { identity, placementStore, workerService } = await support.placementHarness(
        `worker-ack-rejection-${kind}`,
        `session-ack-rejection-${kind}`,
        { liveEvents, applyTranscriptCommit: support.successfulTranscriptCommit("entry-retry") },
      );
      const error = new Error("ACK persistence refused");
      placementStore.updateAckCursors.mockRejectedValueOnce(error);
      const request = () =>
        kind === "transcript"
          ? workerService.commitTranscript(identity, support.transcriptRequest(identity, "retry"))
          : workerService.pushLiveEvent(identity, support.terminalEvent(identity));
      await expect(request()).rejects.toBe(error);
      await expect(request()).resolves.toMatchObject({ ok: true });
      expect(placementStore.updateAckCursors).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["end", "finishing"] as const)(
    "keeps preview ACKs in memory and durably fences %s",
    async (phase) => {
      const applyTranscriptCommit = support.successfulTranscriptCommit("entry-placement");
      const { liveEvents } = support.sequencedLiveEvents();
      const { identity, placementStore, workerService } = await support.placementHarness(
        "worker-placement-ack",
        "session-placement-ack",
        {
          applyTranscriptCommit,
          liveEvents,
        },
      );
      const claim = identity.turnClaim!;

      await expect(
        workerService.commitTranscript(
          identity,
          support.transcriptRequest(identity, "commit", { seq: 7 }),
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
        claim,
        transcriptSeq: 7,
        assertCurrent: expect.any(Function),
      });

      await expect(
        workerService.pushLiveEvent(identity, support.assistantEvent(identity, "preview")),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
      expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();

      await expect(
        workerService.pushLiveEvent(identity, {
          ...support.terminalEvent(identity, { lastAckedSeq: 1, seq: 2 }),
          event: { kind: "lifecycle", payload: { phase, startedAt: 1, endedAt: 2 } },
        }),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
      expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
        claim,
        liveSeq: 2,
        assertCurrent: expect.any(Function),
      });
    },
  );

  it("advances the transcript cursor when a stale-base commit consumes its sequence", async () => {
    const applyTranscriptCommit = vi
      .fn<NonNullable<WorkerEnvironmentServiceOptions["applyTranscriptCommit"]>>()
      .mockResolvedValueOnce({ ok: false, reason: "stale-base-leaf" })
      .mockResolvedValueOnce({ ok: false, reason: "invalid-batch" });
    const { identity, placementStore, workerService } = await support.placementHarness(
      "worker-placement-stale",
      "session-placement-stale",
      { applyTranscriptCommit },
    );
    const request = support.transcriptRequest(identity, "stale commit", {
      seq: 11,
      baseLeafId: "stale-leaf",
    });

    await expect(workerService.commitTranscript(identity, request)).resolves.toEqual({
      ok: false,
      reason: "stale-base-leaf",
    });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      claim: identity.turnClaim,
      transcriptSeq: 11,
      assertCurrent: expect.any(Function),
    });

    await expect(
      workerService.commitTranscript(identity, { ...request, seq: 12 }),
    ).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
  });

  it("fences after a buffered terminal event becomes acknowledged by a gap fill", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-terminal-gap");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents((seq) =>
      seq === 1 ? 2 : 0,
    );
    const { identity, placementStore, workerService } = await support.placementHarness(
      "worker-placement-gap",
      "session-placement-gap",
      {
        applyTranscriptCommit,
        liveEvents,
      },
    );

    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity, { seq: 2 })),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "fills gap")),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      claim: identity.turnClaim,
      liveSeq: 2,
      assertCurrent: expect.any(Function),
    });
    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "late transcript"),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.assistantEvent(identity, "late", { lastAckedSeq: 2, seq: 3 }),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).not.toHaveBeenCalled();
    expect(liveApply).toHaveBeenCalledTimes(2);
  });

  it("holds terminal events behind transcript commit and delayed durable ACK settlement", async () => {
    const commitStarted = createDeferredCore();
    const { promise: commitBlocked, resolve: finishCommit } = createDeferredCore();
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-order", () => {
      commitStarted.resolve();
      return commitBlocked;
    });
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = await support.placementHarness(
      "worker-placement-order",
      "session-placement-order",
      { applyTranscriptCommit, liveEvents },
    );
    const ackStarted = createDeferredCore();
    const ackSettled = createDeferredCore();
    placementStore.updateAckCursors.mockImplementationOnce(async () => {
      ackStarted.resolve();
      await ackSettled.promise;
    });

    const commit = workerService.commitTranscript(
      identity,
      support.transcriptRequest(identity, "commit before terminal"),
    );
    await commitStarted.promise;
    const terminal = workerService.pushLiveEvent(identity, support.terminalEvent(identity));
    await Promise.resolve();
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    finishCommit?.();
    await ackStarted.promise;
    expect(liveApply).not.toHaveBeenCalled();
    ackSettled.resolve();
    await expect(commit).resolves.toMatchObject({ ok: true });
    await expect(terminal).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors.mock.calls).toEqual([
      [
        {
          claim: identity.turnClaim,
          transcriptSeq: 1,
          assertCurrent: expect.any(Function),
        },
      ],
      [
        {
          claim: identity.turnClaim,
          liveSeq: 1,
          assertCurrent: expect.any(Function),
        },
      ],
    ]);
  });
});
