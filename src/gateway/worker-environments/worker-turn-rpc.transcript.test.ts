import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createPlacementTurnClaimFixtureOps } from "./placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

describe("worker transcript claim fences", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["released", "replaced", "preparation"] as const)(
    "does not persist or publish a transcript after its worker claim is fenced: %s",
    async (scenario) => {
      const identity = await support.seedAttachedIdentity(
        "worker-commit-race",
        "session-commit-race",
      );
      const { claim, store } = await claimWorkerPlacement({
        environmentId: identity.environmentId,
        ownerEpoch: identity.ownerEpoch,
        sessionId: "session-commit-race",
      });
      identity.turnClaim = claim;
      const target = {
        agentId: "main",
        sessionId: claim.sessionId,
        sessionKey: `agent:main:${claim.sessionId}`,
        storePath: path.join(support.testState.root, "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: claim.sessionId,
        lifecycleRevision: "unchanged-lifecycle",
        updatedAt: 1,
      });
      const entryBefore = loadSessionEntry(target);
      const ledger = createWorkerTranscriptCommitStore({ database: support.testState.stateDb });
      const applicationStarted = createDeferredCore();
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => ({ session: { store: target.storePath } }),
        store: {
          ...ledger,
          begin(input) {
            const result = ledger.begin(input);
            applicationStarted.resolve();
            return result;
          },
        },
      });
      const workerService = support.createService(support.createProvider(), {
        placementStore: createWorkerSessionPlacementGate(store),
        applyTranscriptCommit: committer.commit,
      });
      const updates: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.sessionId === claim.sessionId) {
          updates.push(update);
        }
      });
      const instance = createOperationalRunInstanceRef(claim.runId);
      const authority = claimAgentRunDelegatedAuthority(instance);
      const claimOps = createPlacementTurnClaimFixtureOps(support.testState.stateDb);
      const prepare = vi.fn((message: ReturnType<typeof makeAgentAssistantMessage>) => {
        claimOps.releaseTurn(claim);
        return message;
      });
      const writerHeld = createDeferredCore();
      const releaseWriter = createDeferredCore();
      const blocker = runExclusiveSqliteSessionWrite(
        { agentId: target.agentId, path: target.storePath },
        async () => {
          writerHeld.resolve();
          await releaseWriter.promise;
        },
        "session.transcript.batch",
      );
      let replacement: WorkerSessionTurnClaim | undefined;
      let replacementAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
      try {
        await bindWorkerTurnOwner(
          store,
          claim,
          undefined,
          instance,
          target,
          () => {},
          scenario === "preparation" ? prepare : undefined,
        );
        await writerHeld.promise;
        const request = support.transcriptRequest(identity, "queued before claim closure");
        if (scenario === "preparation") {
          request.messages.push(
            makeAgentAssistantMessage({ content: [{ type: "text", text: "prepared after user" }] }),
          );
        }
        const commit = workerService.commitTranscript(identity, request);
        await applicationStarted.promise;
        expect(await loadTranscriptEvents(target)).toEqual([]);
        if (scenario !== "preparation") {
          await store.releaseTurn(claim);
          if (scenario === "replaced") {
            replacement = await store.claimTurn({
              ...target,
              claimId: "replacement-claim",
              runId: "replacement-run",
              owner: claim.owner,
            });
          }
        }
        releaseWriter.resolve();
        await blocker;
        await expect(commit).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
        expect(SessionManager.open(target).getEntries()).toEqual([]);
        expect(loadSessionEntry(target)).toEqual(entryBefore);
        expect(updates).toEqual([]);
        expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBeNull();
        expect(prepare).toHaveBeenCalledTimes(scenario === "preparation" ? 1 : 0);

        replacement ??= await store.claimTurn({
          ...target,
          claimId: "replacement-claim",
          runId: "replacement-run",
          owner: claim.owner,
        });
        const replacementInstance = createOperationalRunInstanceRef(replacement.runId);
        replacementAuthority = claimAgentRunDelegatedAuthority(replacementInstance);
        await bindWorkerTurnOwner(
          store,
          replacement,
          undefined,
          replacementInstance,
          target,
          () => {},
        );
        const credential = await workerService.acquireTurnCredential(replacement);
        expect(credential.ownerEpoch).toBe(identity.ownerEpoch);
        expect(await workerService.acknowledgeCredentialDelivery(credential)).toBe(true);
        const admitted = await workerService.admitWorker({
          environmentId: identity.environmentId,
          credential: credential.credential,
          sessionId: claim.sessionId,
          runId: replacement.runId,
          ownerEpoch: credential.ownerEpoch,
          rpcSetVersion: 1,
          handshake: support.BOOTSTRAP_RECEIPT,
        });
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) {
          throw new Error("replacement worker was not admitted");
        }
        const seq = (store.get(claim.sessionId)?.lastTranscriptAckCursor ?? 0) + 1;
        expect(seq).toBe(request.seq);
        await expect(
          workerService.commitTranscript(
            admitted.identity,
            support.transcriptRequest(admitted.identity, "replacement can commit", { seq }),
          ),
        ).resolves.toMatchObject({ ok: true });
        expect(SessionManager.open(target).getEntries()).toHaveLength(1);
        expect(updates).toHaveLength(1);
        expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBe(seq);
      } finally {
        releaseWriter.resolve();
        await blocker;
        unsubscribe();
        if (store.validateTurnClaim(replacement ?? claim)) {
          await store.releaseTurn(replacement ?? claim);
        }
        releaseAgentRunDelegatedAuthority(authority);
        if (replacementAuthority) {
          releaseAgentRunDelegatedAuthority(replacementAuthority);
        }
      }
    },
  );

  it.each(["current", "deleted", "claim-released"] as const)(
    "keeps an admitted transcript on its original store after configuration changes: %s",
    async (scenario) => {
      const identity = await support.seedAttachedIdentity("worker-source", "session-source");
      const { claim, store } = await claimWorkerPlacement({
        environmentId: identity.environmentId,
        ownerEpoch: identity.ownerEpoch,
        sessionId: "session-source",
      });
      identity.turnClaim = claim;
      const original = {
        agentId: "main",
        sessionId: claim.sessionId,
        sessionKey: `agent:main:${claim.sessionId}`,
        storePath: path.join(support.testState.root, "original", "sessions.json"),
        expectedLifecycleRevision: "source-lifecycle",
        expectedWriterRunId: claim.runId,
      };
      const replacement = {
        ...original,
        storePath: path.join(support.testState.root, "replacement", "sessions.json"),
      };
      const entry = {
        sessionId: claim.sessionId,
        lifecycleRevision: original.expectedLifecycleRevision,
        activeWriterRunId: claim.runId,
        updatedAt: 1,
      };
      await upsertSessionEntryCore(original, entry);
      await upsertSessionEntryCore(replacement, entry);
      const replacementBefore = loadSessionEntry(replacement);
      support.testState.config.session = { store: original.storePath };
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => support.testState.config,
        store: createWorkerTranscriptCommitStore({ database: support.testState.stateDb }),
      });
      const workerService = support.createService(support.createProvider(), {
        placementStore: createWorkerSessionPlacementGate(store),
        applyTranscriptCommit: committer.commit,
      });
      const instance = createOperationalRunInstanceRef(claim.runId);
      const authority = claimAgentRunDelegatedAuthority(instance);
      try {
        await bindWorkerTurnOwner(store, claim, undefined, instance, original, () => {
          resolveWorkerTurnTranscriptTarget({ ...original, sessionTarget: original });
        });
        support.testState.config.session = { store: replacement.storePath };
        if (scenario === "deleted") {
          await expect(
            deleteSessionEntryLifecycle({
              agentId: original.agentId,
              storePath: original.storePath,
              archiveTranscript: false,
              target: { canonicalKey: original.sessionKey, storeKeys: [original.sessionKey] },
            }),
          ).resolves.toMatchObject({ deleted: true });
        } else if (scenario === "claim-released") {
          await store.releaseTurn(claim);
        }
        const result = workerService.commitTranscript(
          identity,
          support.transcriptRequest(identity, "Write only to the admitted source"),
        );
        if (scenario === "current") {
          await expect(result).resolves.toMatchObject({ ok: true });
          expect(SessionManager.open(original).getEntries()).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({
                role: "user",
                content: [{ type: "text", text: "Write only to the admitted source" }],
              }),
            }),
          ]);
          expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBe(1);
        } else {
          if (scenario === "deleted") {
            await expect(result).rejects.toThrow("transcript identity is no longer current");
            expect(loadSessionEntry(original)).toBeUndefined();
          } else {
            await expect(result).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
            expect(SessionManager.open(original).getEntries()).toEqual([]);
          }
          expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBeNull();
        }
        expect(SessionManager.open(replacement).getEntries()).toEqual([]);
        expect(loadSessionEntry(replacement)).toEqual(replacementBefore);
      } finally {
        if (store.validateTurnClaim(claim)) {
          await store.releaseTurn(claim);
        }
        releaseAgentRunDelegatedAuthority(authority);
      }
    },
  );
});
