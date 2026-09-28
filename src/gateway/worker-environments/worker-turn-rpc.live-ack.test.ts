import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
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
  const previous = claimWorkerPlacement({
    environmentId,
    ownerEpoch: previousIdentity.ownerEpoch,
    sessionId,
  });
  previous.store.updateAckCursors({ claim: previous.claim, liveEvent: ackedSeq });
  const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
  const placementStore = createWorkerSessionPlacementGate(placements, {
    rejectExistingWorkerClaims: true,
  });
  expect(placementStore.validateWorkerTurn(previous.claim)).toBe(false);
  placements.acceptWorkspaceResult(previous.claim);
  placements.completeWorkspaceResultAndReleaseTurn(previous.claim);
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(support.testState.root, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  const claim = placements.claimTurn({
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

  it("continues the recovered durable cursor under a fresh claim", async () => {
    const { identity, placements, workerService } = await recoveredTurn();
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.assistantEvent(identity, "resumed", { seq: 6, lastAckedSeq: 5 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 6 } });
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { seq: 7, lastAckedSeq: 6 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 7 } });
    expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(7);
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
  });

  it.each([0, 5])(
    "rejects a worker cursor beyond its durable recovered ACK %s",
    async (ackedSeq) => {
      const { identity, placements, workerService } = await recoveredTurn(ackedSeq);
      await expect(
        workerService.pushLiveEvent(
          identity,
          support.terminalEvent(identity, { seq: 21, lastAckedSeq: 20 }),
        ),
      ).resolves.toEqual({
        ok: false,
        details: { reason: "resync-required", ackedSeq, expectedSeq: ackedSeq + 1 },
      });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(ackedSeq);
    },
  );

  it.each([false, true])(
    "does not grant terminal authority to a previously ACKed sequence (transcript first: %s)",
    async (transcriptFirst) => {
      const { identity, placements, workerService } = await recoveredTurn();
      if (transcriptFirst) {
        await expect(
          workerService.commitTranscript(identity, support.transcriptRequest(identity, "current")),
        ).resolves.toMatchObject({ ok: true });
      }
      await expect(
        workerService.pushLiveEvent(
          identity,
          support.terminalEvent(identity, { seq: 5, lastAckedSeq: 5 }),
        ),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: 5 } });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      await expect(
        workerService.pushLiveEvent(
          identity,
          support.assistantEvent(identity, "still active", { seq: 6, lastAckedSeq: 5 }),
        ),
      ).resolves.toEqual({ ok: true, result: { ackedSeq: 6 } });
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
    expect(placements.listPendingWorkspaceResults()).toEqual([]);
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { seq: 8, lastAckedSeq: 7 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 8 } });
    expect(placements.get(identity.sessionId!)?.lastLiveEventAckCursor).toBe(8);
  });
});
