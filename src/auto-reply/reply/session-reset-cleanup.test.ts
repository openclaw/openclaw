import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "../../agents/agent-project-settings.js";
import { completePromptCacheObservation } from "../../agents/embedded-agent-runner/prompt-cache-observability.js";
import { beginOpenAIObservation } from "../../agents/embedded-agent-runner/prompt-cache-observability.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import {
  captureSessionRecipientAuthority,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { isSessionRecipientAuthorityCurrentInWorker } from "../../config/sessions/session-recipient-authority-current.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEventRaw as enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerContinuationDispatchClaim } from "../continuation/continuation-dispatch-claims.js";
import { resetContinuationCustodyProjection } from "../continuation/custody/custody-projection.js";
import {
  hydrateContinuationCustody,
  updateContinuationRecords,
} from "../continuation/custody/custody-store.js";
import {
  custodyStateForTest,
  listCustodyRecordsForTest,
  readCustodyRecordForTest,
  useContinuationCustodyTestState,
} from "../continuation/custody/custody.test-support.js";
import { readAcceptedDelegateChildSessionKey } from "../continuation/delegate-flow-store.js";
import {
  claimStagedPostCompactionDelegates,
  releaseStagedPostCompactionDelegateToQueue,
  stagePostCompactionCustodyDelegate,
  toSessionPostCompactionDelegate,
} from "../continuation/delegate-store-post-compaction.js";
import {
  consumePendingDelegates,
  enqueuePendingDelegate,
  markPendingDelegateSpawnAccepted,
} from "../continuation/delegate-store.js";
import {
  hasLiveContinuationTimerRefs,
  registerContinuationTimerHandle,
  releaseContinuationTimerRef,
  retainContinuationTimerRef,
} from "../continuation/state.js";
import { enqueueContinuationReturnDeliveries } from "../continuation/targeting.js";
import type { PendingContinuationWork } from "../continuation/work-flow-state.js";
import {
  resetWorkOperatorContinuationsForTests,
  retainWorkOperatorContinuation,
} from "../continuation/work-operator-continuation.js";
import { enqueuePendingWorkReplacing } from "../continuation/work-replacement-store.js";
import { consumePendingWork } from "../continuation/work-store.js";
import { clearFollowupQueue } from "./queue/state.js";
import { clearReplacedSessionRuntimeState } from "./session-init-reset-cleanup.js";
import {
  clearSessionResetRuntimeState,
  prepareSessionResetCleanupGuard,
} from "./session-reset-cleanup.js";

const sessionInitWarn = vi.hoisted(() => vi.fn());

// Committed-reset cleanup is best-effort and reports failures through its warn log.
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "session-init" ? { ...logger, warn: sessionInitWarn } : logger;
    },
  };
});

useContinuationCustodyTestState();

// Seed queued work through the real custody election path.
async function enqueuePendingWork(work: PendingContinuationWork): Promise<PendingContinuationWork> {
  const result = await enqueuePendingWorkReplacing({
    work,
    summary: "seeded reset test work",
    maxPendingWork: Number.MAX_SAFE_INTEGER,
    replaceParkedWork: false,
    expectedRunningFlowIds: [],
  });
  if (!result.applied) {
    throw new Error("expected seeded continuation work to be elected");
  }
  return result.work;
}

// Stage, claim and release one post-compaction delegate into the session
// delivery queue: the release is the permanent durable handoff.
async function handOffPostCompactionDelegate(sessionKey: string, task: string) {
  await stagePostCompactionCustodyDelegate(sessionKey, { task, stagedAt: Date.now() });
  const claimed = (await claimStagedPostCompactionDelegates(sessionKey))[0];
  if (!claimed?.flowId) {
    throw new Error("expected claimed post-compaction delegate");
  }
  expect(
    await releaseStagedPostCompactionDelegateToQueue({
      sessionKey,
      delegate: toSessionPostCompactionDelegate(claimed),
      sequence: 0,
    }),
  ).toMatchObject({ released: true });
  return { ...claimed, flowId: claimed.flowId };
}

afterEach(() => {
  sessionInitWarn.mockReset();
  clearEmbeddedSessionPromptStates(["old-session"]);
  controllerTesting.resetSessionControllerForTest();
  resetDiagnosticRunActivityForTest();
  resetSystemEventsForTest();
});

const replySessionKey = "agent:main:slack:room:1";
async function clearArchived(keys = [replySessionKey, "old-session"]) {
  await clearSessionResetRuntimeState(keys, {
    agentId: "main",
    reason: "reset",
    sessionKey: replySessionKey,
    activeReplySessionId: "old-session",
    assertCurrent: () => {},
  });
}
function createOperation(sessionId = "old-session") {
  return createReplyOperation({ sessionKey: replySessionKey, sessionId, resetTriggered: false });
}

describe("clearSessionResetRuntimeState", () => {
  it("refreshes prepared settings only for the archived session", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-settings-"));
    const archivedSessionId = `${cwd}:archived`;
    const retainedSessionId = `${cwd}:retained`;
    const params = {
      cwd,
      agentDir: cwd,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    };
    const settingsPath = path.join(cwd, "settings.json");
    const writeSettings = (keepRecentTokens: number) =>
      fs.writeFile(settingsPath, JSON.stringify({ compaction: { keepRecentTokens } }));
    const readSettings = (sessionId: string) =>
      createPreparedEmbeddedAgentSettingsManager({
        ...params,
        sessionId,
      }).getCompactionKeepRecentTokens();
    try {
      await writeSettings(25_000);
      for (const sessionId of [archivedSessionId, retainedSessionId]) {
        expect(readSettings(sessionId)).toBe(25_000);
      }
      await writeSettings(35_000);

      await clearSessionResetRuntimeState([archivedSessionId], {
        agentId: "main",
        reason: "reset",
        sessionKey: "agent:main:settings-reset",
        activeReplySessionId: archivedSessionId,
        assertCurrent: () => {},
      });

      expect(readSettings(archivedSessionId)).toBe(35_000);
      expect(readSettings(retainedSessionId)).toBe(25_000);
    } finally {
      clearPreparedEmbeddedAgentSettings([archivedSessionId, retainedSessionId]);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("disposes prompt projections with the archived session", async () => {
    using original = retainEmbeddedSessionPromptState("old-session");
    const state = original.state;

    await clearArchived(["old-session"]);

    using replacement = retainEmbeddedSessionPromptState("old-session");
    expect(replacement.state).not.toBe(state);
  });

  it("clears the archived diagnostic baseline when a reply rotates its session", async () => {
    const identity = { sessionId: "old-session", sessionKey: replySessionKey };
    beginOpenAIObservation(identity);
    completePromptCacheObservation({ ...identity, usage: { cacheRead: 8_000 } });

    await clearReplacedSessionRuntimeState({
      previousSessionEntry: { sessionId: identity.sessionId },
      previousSessionEndReason: "reset",
      storePath: "/synthetic/reset-observability.sqlite",
      agentId: "main",
      sessionKey: replySessionKey,
    });

    expect(sessionInitWarn).not.toHaveBeenCalled();
    expect(beginOpenAIObservation(identity).previousCacheRead).toBeNull();
  });

  it("clears reset queues and drains system events for normalized keys", async () => {
    enqueueSystemEvent("stale alpha", withSystemEventOwner({ sessionKey: "alpha" }, "main"));
    enqueueSystemEvent("stale beta", withSystemEventOwner({ sessionKey: "beta" }, "main"));
    enqueueSystemEvent("fresh gamma", withSystemEventOwner({ sessionKey: "gamma" }, "main"));

    await clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"], {
      agentId: "main",
      reason: "reset",
      sessionKey: "alpha",
      assertCurrent: () => {},
    });

    expect(peekSystemEvents("agent:main:alpha")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:beta")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:gamma")).toEqual(["fresh gamma"]);
  });

  it("preserves events owned by other agents during an agent-scoped reset", async () => {
    enqueueSystemEvent("main", withSystemEventOwner({ sessionKey: "global" }, "main"));
    enqueueSystemEvent("alpha", withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent("beta", withSystemEventOwner({ sessionKey: "global" }, "beta"));

    await clearSessionResetRuntimeState(["global", "agent:beta:global"], {
      agentId: " Alpha ",
      reason: "reset",
      sessionKey: "global",
      assertCurrent: () => {},
    });

    expect(peekSystemEvents("agent:alpha:global")).toEqual([]);
    expect(peekSystemEvents("agent:main:global")).toEqual(["main"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["beta"]);
  });

  it("retains archived reply custody until its actual producer returns", async () => {
    const cancel = vi.fn();
    const operation = createOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");
    const raw = createDeferred();
    const producer = raw.promise.then(() => operation.complete());
    try {
      await clearArchived();
      expect(cancel).toHaveBeenCalledWith("restart");
      expect(isSessionRunActiveForKey(replySessionKey)).toBe(true);
      expect(() => createOperation("new-session")).toThrow("already active");
      raw.resolve();
      await producer;
      await operation.ownerSettlement;
      const nextOperation = createOperation("new-session");
      expect(nextOperation.sessionId).toBe("new-session");
      nextOperation.complete();
    } finally {
      raw.resolve();
      await producer;
    }
  });

  it.each([
    ["new-session", "running"],
    ["old-session", "queued"],
  ] as const)("preserves %s/%s while clearing archived runtime state", async (sessionId, phase) => {
    const operation = createOperation(sessionId);
    if (phase === "running") {
      operation.setPhase(phase);
    }
    await clearArchived();
    expect(operation.phase).toBe(phase);
    expect(getSessionControllerOperation(replySessionKey)).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", async () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createOperation();
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    await clearArchived();

    expect(replacement).toBeDefined();
    expect(getSessionControllerOperation(replySessionKey)).toBe(replacement);
  });

  it("clears queued sources without cancelling the executing reset turn that requested it", async () => {
    const sessionKey = "agent:main:dashboard:reset-self";
    enqueueSystemEvent("stale", withSystemEventOwner({ sessionKey }, "main"));
    // A `/new` or `/reset` chat turn owns a claimed controller input and runs
    // initSessionState as that claim's operation; its reply signal is the input's.
    const storePath = "/synthetic/reset-self.sqlite";
    const target = captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" });
    const resetTurn = reserveSessionControllerSource(sessionKey, {
      policy: { mode: "followup" },
      target,
    });
    const claim = tryClaimSessionControllerTask(resetTurn);
    if (!claim) {
      throw new Error("expected reset turn claim");
    }
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "old-session",
      resetTriggered: true,
      mailboxClaim: claim,
      upstreamAbortSignal: claim.abortController.signal,
    });
    const queued = reserveSessionControllerSource(sessionKey, {
      policy: { mode: "followup" },
      target,
    });
    try {
      await withSessionControllerOwner(operation, () =>
        clearReplacedSessionRuntimeState({
          previousSessionEntry: { sessionId: "old-session" },
          previousSessionEndReason: "reset",
          storePath,
          agentId: "main",
          sessionKey,
          signal: resetTurn.abortSignal,
        }),
      );

      expect(sessionInitWarn).not.toHaveBeenCalled();
      expect(resetTurn.abortSignal.aborted).toBe(false);
      expect(queued.abortSignal.aborted).toBe(true);
      expect(peekSystemEvents(sessionKey)).toStrictEqual([]);
      // A clear outside that turn still cancels its claimed input.
      clearFollowupQueue(sessionKey);
      expect(resetTurn.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
  });

  // /new and /reset keep elections not yet driven for the successor (#1271); delete ends them.
  it.each(["new", "reset", "delete"] as const)(
    "%s settles pending session work by its boundary while preserving accepted return authority",
    async (reason) => {
      const endsSession = reason === "delete";
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-session-reset-continuation-" },
        async () => {
          await captureRuntimeConfigAsyncReader()();
          // The fixture moved the state directory; hydrate its custody projection.
          await hydrateContinuationCustody();
          vi.useFakeTimers();
          const sessionKey = "agent:main:slack:room:reset";
          const unrelatedSessionKey = "agent:main:slack:room:unrelated";
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              { sessionId: "accepted-mailbox", updatedAt: 1 },
            );
            const recipientAuthority = await captureSessionRecipientAuthority({
              agentId: "main",
              sessionKey,
            });
            const work = await enqueuePendingWork({
              sessionKey,
              hop: 1,
              delayMs: 60_000,
              electedAt: Date.now(),
              dueAt: Date.now() + 60_000,
              maxChainLength: 8,
            });
            const delegate = await enqueuePendingDelegate(sessionKey, {
              task: "continue after reset",
              delayMs: 60_000,
            });
            const unrelatedWork = await enqueuePendingWork({
              sessionKey: unrelatedSessionKey,
              hop: 1,
              delayMs: 60_000,
              electedAt: Date.now(),
              dueAt: Date.now() + 60_000,
              maxChainLength: 8,
            });
            const terminalWork = await enqueuePendingWork({
              sessionKey,
              hop: 1,
              delayMs: 0,
              electedAt: Date.now(),
              dueAt: Date.now(),
              maxChainLength: 8,
            });
            const handedOffDelegate = await handOffPostCompactionDelegate(
              sessionKey,
              "do not replay handed-off work",
            );
            const acceptedPostCompaction = await handOffPostCompactionDelegate(
              sessionKey,
              "already accepted post-compaction work",
            );
            const acceptedRecord = await readCustodyRecordForTest(acceptedPostCompaction.flowId);
            if (!acceptedRecord) {
              throw new Error("expected handed-off post-compaction record");
            }
            expect(
              await markPendingDelegateSpawnAccepted(
                {
                  ...acceptedPostCompaction,
                  expectedRevision: acceptedRecord.revision,
                },
                "agent:main:subagent:accepted",
              ),
            ).toBe(true);
            const acceptedAfterRecording = await readCustodyRecordForTest(
              acceptedPostCompaction.flowId,
            );
            if (!acceptedAfterRecording) {
              throw new Error("expected accepted post-compaction record");
            }
            expect(custodyStateForTest(acceptedAfterRecording)).toMatchObject({
              childSessionKey: "agent:main:subagent:accepted",
            });
            expect(readAcceptedDelegateChildSessionKey(acceptedAfterRecording)).toBe(
              "agent:main:subagent:accepted",
            );
            if (!work.flowId || !unrelatedWork.flowId || !terminalWork.flowId) {
              throw new Error("expected durable continuation records");
            }
            const activeDelegate = registerContinuationDispatchClaim({
              sessionKey,
              flowId: delegate.recordId,
            });
            const terminalized = await updateContinuationRecords(
              [
                {
                  recordId: terminalWork.flowId,
                  ownerSessionKey: sessionKey,
                  expectedRevision: terminalWork.expectedRevision!,
                  patch: { status: "succeeded", phase: "Already completed" },
                },
              ],
              { now: Date.now() },
            );
            expect(terminalized.outcome).toBe("applied");

            retainContinuationTimerRef(sessionKey);
            timer = setTimeout(() => {}, 60_000);
            registerContinuationTimerHandle(sessionKey, timer);
            expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

            await clearSessionResetRuntimeState([sessionKey], {
              agentId: "main",
              reason,
              sessionKey,
              assertCurrent: () => {},
            });
            await vi.advanceTimersByTimeAsync(0);

            const records = new Map(
              (await listCustodyRecordsForTest()).map((record) => [record.recordId, record]),
            );
            const pendingStatus = endsSession ? "cancelled" : "queued";
            expect(records.get(work.flowId)?.status).toBe(pendingStatus);
            expect(records.get(delegate.recordId)?.status).toBe(pendingStatus);
            // The in-process claim belongs to the replaced head either way.
            expect(activeDelegate.controller.signal.aborted).toBe(true);
            expect(records.get(unrelatedWork.flowId)?.status).toBe("queued");
            expect(records.get(terminalWork.flowId)?.status).toBe("succeeded");
            // Handoffs are permanent (RFC §5.4.4): reset fences the unaccepted
            // handed-off record instead of cancelling it, and leaves the
            // accepted one untouched.
            expect(records.get(handedOffDelegate.flowId)).toMatchObject({
              status: "succeeded",
              cancelRequestedAt: expect.any(Number),
            });
            expect(records.get(acceptedPostCompaction.flowId)?.status).toBe("succeeded");
            expect(records.get(acceptedPostCompaction.flowId)?.cancelRequestedAt).toBeUndefined();
            expect(await consumePendingWork(sessionKey, { includeRunning: true })).toEqual([]);
            expect(await consumePendingDelegates(sessionKey)).toEqual([]);
            const keptLive = endsSession
              ? []
              : [
                  expect.objectContaining({ recordId: work.flowId, status: "queued" }),
                  expect.objectContaining({ recordId: delegate.recordId, status: "queued" }),
                ];
            expect(
              await listCustodyRecordsForTest({
                ownerSessionKey: sessionKey,
                statuses: ["queued", "running"],
              }),
            ).toEqual(keptLive);
            expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
            expect(
              await isSessionRecipientAuthorityCurrentInWorker(
                { agentId: "main", sessionKey },
                recipientAuthority,
              ),
            ).toBe(true);
            const delivered = await enqueueContinuationReturnDeliveries({
              targetSessionKeys: [sessionKey],
              text: "[continuation:enrichment-return] accepted child completed",
              idempotencyKeyBase: `accepted-after-${reason}`,
              recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
              ownerAgentId: "main",
            });
            expect(delivered).toMatchObject({ enqueued: 1, delivered: 1 });
            expect(peekSystemEvents(sessionKey)).toContain(
              "[continuation:enrichment-return] accepted child completed",
            );

            // Restart: reopen the state database and rehydrate custody from
            // committed rows only.
            resetContinuationCustodyProjection();
            await closeOpenClawStateDatabaseAsync();
            await hydrateContinuationCustody();
            expect(await consumePendingWork(sessionKey, { includeRunning: true })).toEqual([]);
            expect(await consumePendingDelegates(sessionKey)).toEqual([]);
            expect(
              await listCustodyRecordsForTest({
                ownerSessionKey: sessionKey,
                statuses: ["queued", "running"],
              }),
            ).toEqual(keptLive);
            expect(await readCustodyRecordForTest(handedOffDelegate.flowId)).toMatchObject({
              status: "succeeded",
              cancelRequestedAt: expect.any(Number),
            });
            expect((await readCustodyRecordForTest(unrelatedWork.flowId))?.status).toBe("queued");
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
            releaseContinuationTimerRef(sessionKey);
            vi.useRealTimers();
          }
        },
      );
    },
  );

  // A kept wake keeps the operator custody it was elected under; the boundary that ends the
  // wake releases it (#1271).
  it.each([
    ["reset", 0],
    ["delete", 1],
  ] as const)(
    "%s releases a queued wake's operator custody only by ending it",
    async (reason, releases) => {
      const sessionKey = "agent:main:slack:room:operator-wake";
      const work = await enqueuePendingWork({
        sessionKey,
        hop: 1,
        delayMs: 60_000,
        electedAt: Date.now(),
        dueAt: Date.now() + 60_000,
        maxChainLength: 8,
        operatorAuthorityRequired: true,
      });
      const release = vi.fn();
      retainWorkOperatorContinuation(work.flowId!, sessionKey, {
        operatorAuthority: { scope: "operator" },
        assertCurrent: () => {},
        run: (run) => run(),
        release,
      });
      try {
        await clearSessionResetRuntimeState([sessionKey], {
          agentId: "main",
          reason,
          sessionKey,
          assertCurrent: () => {},
        });

        expect(release).toHaveBeenCalledTimes(releases);
        expect((await readCustodyRecordForTest(work.flowId!))?.status).toBe(
          reason === "delete" ? "cancelled" : "queued",
        );
      } finally {
        resetWorkOperatorContinuationsForTests();
      }
    },
  );
});

it("keeps reset cleanup current through metadata writes and refuses a replacement session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:reset-cleanup";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const entry = { sessionId: "before-reset", lifecycleRevision: "original", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const cleanup = await prepareSessionResetCleanupGuard({ ...scope, expectedSession: entry });
    try {
      await replaceSessionEntry(scope, { ...entry, updatedAt: 2, label: "Renamed" });
      expect(() => cleanup.assertCurrent()).not.toThrow();
      await replaceSessionEntry(scope, {
        sessionId: "replacement",
        lifecycleRevision: "replacement",
        updatedAt: 3,
      });
      enqueueSystemEvent("replacement work", withSystemEventOwner({ sessionKey }, agentId));
      await expect(
        clearSessionResetRuntimeState([sessionKey, entry.sessionId], {
          agentId,
          reason: "reset",
          sessionKey,
          activeReplySessionId: entry.sessionId,
          assertCurrent: cleanup.assertCurrent,
        }),
      ).rejects.toThrow("session changed before cleanup");
      expect(peekSystemEvents(sessionKey)).toEqual(["replacement work"]);
    } finally {
      cleanup.release();
    }
  });
});
