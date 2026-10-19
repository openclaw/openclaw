import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerOperations } from "../../infra/sqlite-worker-contract.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentWorkerStore from "../../state/openclaw-agent-worker-store.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createPlacementTurnClaimFixtureOps } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  bindClaimOwner,
  claimAdmission,
  claimService,
  claimTarget,
  seedClaim,
  turnRequests,
} from "./worker-turn-rpc-fixtures.test-support.js";
import { prepareWorkerTurnTranscriptSource } from "./worker-turn-transcript-target.js";

type Owner = Awaited<ReturnType<typeof bindClaimOwner>>;
function transcriptService(
  store: Awaited<ReturnType<typeof seedClaim>>["store"],
  getConfig: Parameters<typeof createWorkerTranscriptCommitter>[0]["getConfig"],
) {
  const committer = createWorkerTranscriptCommitter({
    getConfig,
    store: createWorkerTranscriptCommitStore({ database: support.testState.stateDb }),
  });
  return claimService(store, { applyTranscriptCommit: committer.commit });
}

async function transcriptFixture(name: string) {
  const { claim, store, environmentIdentity } = await seedClaim(
    `worker-${name}`,
    `session-${name}`,
  );
  return { claim, store, identity: { ...environmentIdentity, turnClaim: claim } };
}

support.setupWorkerEnvironmentServiceSuite();

it.each(["replaced", "preparation"] as const)(
  "does not persist or publish a transcript after its worker claim is fenced: %s",
  async (scenario) => {
    const { claim, store, identity } = await transcriptFixture("commit-race");
    const target = claimTarget(claim.sessionId, "openclaw-agent.sqlite");
    await upsertSessionEntryCore(target, {
      sessionId: claim.sessionId,
      lifecycleRevision: "unchanged-lifecycle",
      updatedAt: 1,
    });
    const entryBefore = loadSessionEntry(target);
    const applicationQueued = createDeferredCore();
    const transcriptWorkerUrl = resolveRuntimeWorkerUrl(
      runtimeProcessEntrypoints.workerTranscriptCommit,
    ).href;
    const openWorker = agentWorkerStore.openOpenClawAgentSqliteWorkerStore;
    const openingWorker = vi
      .spyOn(agentWorkerStore, "openOpenClawAgentSqliteWorkerStore")
      .mockImplementation(
        async <Operations extends SqliteWorkerOperations>(
          ...args: Parameters<typeof openWorker<Operations>>
        ) => {
          const worker = await openWorker<Operations>(...args);
          if (args[2].moduleUrl.href !== transcriptWorkerUrl) {
            return worker;
          }
          return {
            ...worker,
            run<T>(...runArgs: Parameters<typeof worker.run<T>>): Promise<T> {
              const pending = worker.run<T>(...runArgs);
              // The real run queues synchronously behind the held transcript writer.
              applicationQueued.resolve();
              return pending;
            },
          };
        },
      );
    const workerService = transcriptService(store, () => ({
      session: { store: target.storePath },
    }));
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionId === claim.sessionId) {
        updates.push(update);
      }
    });
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
    let owner: Owner | undefined;
    let replacementOwner: Owner | undefined;
    let commit: ReturnType<typeof workerService.commitTranscript> | undefined;
    const claimReplacement = () =>
      store.claimTurn({
        ...target,
        claimId: "replacement-claim",
        runId: "replacement-run",
        owner: claim.owner,
      });
    try {
      owner = await bindClaimOwner(store, claim, {
        target,
        prepare: scenario === "preparation" ? prepare : undefined,
      });
      await writerHeld.promise;
      const request = support.transcriptRequest(identity, "queued before claim closure");
      if (scenario === "preparation") {
        request.messages.push(
          makeAgentAssistantMessage({ content: [{ type: "text", text: "prepared after user" }] }),
        );
      }
      commit = workerService.commitTranscript(identity, request);
      await awaitGateBeforeSettlement(
        applicationQueued.promise,
        commit,
        "transcript commit settled before queuing its writer",
      );
      expect(await loadTranscriptEvents(target)).toEqual([]);
      if (scenario !== "preparation") {
        await store.releaseTurn(claim);
        replacement = await claimReplacement();
      }
      releaseWriter.resolve();
      await blocker;
      await expect(commit).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
      expect({
        entries: SessionManager.open(target).getEntries(),
        entry: loadSessionEntry(target),
        updates,
        cursor: store.get(claim.sessionId)?.lastTranscriptAckCursor,
      }).toEqual({ entries: [], entry: entryBefore, updates: [], cursor: null });
      expect(prepare).toHaveBeenCalledTimes(scenario === "preparation" ? 1 : 0);

      replacement ??= await claimReplacement();
      replacementOwner = await bindClaimOwner(store, replacement, { target });
      const credential = await workerService.acquireTurnCredential(replacement);
      expect(credential.ownerEpoch).toBe(identity.ownerEpoch);
      expect(await workerService.acknowledgeCredentialDelivery(credential)).toBe(true);
      const admitted = await workerService.admitWorker(
        claimAdmission(replacement, credential.credential),
      );
      assert(admitted.ok, "replacement worker was not admitted");
      const seq = (store.get(claim.sessionId)?.lastTranscriptAckCursor ?? 0) + 1;
      expect(seq).toBe(request.seq);
      await expect(
        turnRequests(admitted.identity, workerService).transcript("replacement can commit", {
          seq,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(SessionManager.open(target).getEntries()).toHaveLength(1);
      expect(updates).toHaveLength(1);
      expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBe(seq);
    } finally {
      releaseWriter.resolve();
      await blocker;
      await Promise.allSettled([commit]);
      openingWorker.mockRestore();
      unsubscribe();
      if (store.validateTurnClaim(replacement ?? claim)) {
        await store.releaseTurn(replacement ?? claim);
      }
      owner?.release();
      replacementOwner?.release();
    }
  },
);

it.each(["current", "deleted"] as const)(
  "keeps an admitted transcript on its original store after configuration changes: %s",
  async (scenario) => {
    const { claim, store, identity } = await transcriptFixture("source");
    const original = {
      ...claimTarget(claim.sessionId, "original/sessions.json"),
      expectedLifecycleRevision: "source-lifecycle",
      expectedWriterRunId: claim.runId,
    };
    const replacement = {
      ...original,
      storePath: claimTarget(claim.sessionId, "replacement/sessions.json").storePath,
    };
    const entry = {
      sessionId: claim.sessionId,
      lifecycleRevision: original.expectedLifecycleRevision,
      activeWriterRunId: claim.runId,
      updatedAt: 1,
    };
    for (const target of [original, replacement]) {
      await upsertSessionEntryCore(target, entry);
    }
    const replacementBefore = loadSessionEntry(replacement);
    support.testState.config.session = { store: original.storePath };
    const workerService = transcriptService(store, () => support.testState.config);
    await using source = await prepareWorkerTurnTranscriptSource(original);
    let owner: Owner | undefined;
    try {
      owner = await bindClaimOwner(store, claim, { target: original, assertCurrent: source });
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
      }
      const text = "Write only to the admitted source";
      const result = turnRequests(identity, workerService).transcript(text);
      if (scenario === "current") {
        await expect(result).resolves.toMatchObject({ ok: true });
        expect(SessionManager.open(original).getEntries()).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text }],
            }),
          }),
        ]);
        expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBe(1);
      } else {
        await expect(result).rejects.toThrow("transcript identity is no longer current");
        expect(loadSessionEntry(original)).toBeUndefined();
        expect(store.get(claim.sessionId)?.lastTranscriptAckCursor).toBeNull();
      }
      expect(SessionManager.open(replacement).getEntries()).toEqual([]);
      expect(loadSessionEntry(replacement)).toEqual(replacementBefore);
    } finally {
      if (store.validateTurnClaim(claim)) {
        await store.releaseTurn(claim);
      }
      owner?.release();
    }
  },
);
