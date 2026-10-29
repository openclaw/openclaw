import { afterEach, expect, it, vi } from "vitest";
import {
  createSubagentRunRecord,
  taskCompletionEvents,
} from "../agents/subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement } from "../agents/subagents/announce/subagent-announce-delivery.js";
import { seedSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import { admitCorrelatedSubagentSessionDelivery } from "../agents/subagents/completion/subagent-completion-delivery.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { readSubagentRun } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as queue from "../infra/session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "../infra/session-delivery-queue.records.js";
import * as lifecycle from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { removeCronRunContinuationSessionIfIdle as removeIdle } from "./run-continuation-cleanup.js";

const base = { agentId: "main", sessionKey: "agent:main:cron:queue-race" };
const exact = { ...base, sessionKey: `${base.sessionKey}:run:run-123` };
const payload = { kind: "systemEvent" as const, sessionKey: exact.sessionKey, text: "resume" };
type QueueContext = ReturnType<typeof captureOpenClawStateWorkerContext>;
const writers = ["ordinary", "claimed"] as const;
const enqueue = async (context: QueueContext, writer: (typeof writers)[number]) =>
  writer === "ordinary"
    ? queue.enqueueSessionDelivery(payload, context)
    : (await queue.enqueueClaimedSessionDelivery(payload, 1_000, context)).id;

async function seedContinuation() {
  setRuntimeConfigSnapshot({});
  await upsertSessionEntryCore(base, { sessionId: "run-123", updatedAt: 1 });
  await upsertSessionEntryCore(exact, {
    ...loadSessionEntry(base)!,
    cronRunContinuation: { lifecycleRevision: "fixture", phase: "ready", basePersisted: true },
  });
  return captureOpenClawStateWorkerContext();
}

const withContinuation = (run: (context: QueueContext) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => run(await seedContinuation()));

function pauseAdmission() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const begin = lifecycle.beginSessionEffect;
  vi.spyOn(lifecycle, "beginSessionEffect").mockImplementationOnce(async (params) => {
    const lease = await begin(params);
    entered.resolve();
    await resume.promise;
    return lease;
  });
  return { entered: entered.promise, resume: () => resume.resolve() };
}

function createCorrelatedRun() {
  const now = Date.now();
  return createSubagentRunRecord({
    runId: "correlated-completion",
    requesterSessionKey: exact.sessionKey,
    requesterDisplayKey: exact.sessionKey,
    task: "complete",
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "done", capturedAt: now },
    delivery: { status: "pending", disposition: "retryable" },
    createdAt: now - 1,
    endedAt: now,
    outcome: { status: "ok" },
  });
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(writers)(
  "retains the alias through %s admission until its own delivery settles",
  async (writer) => {
    const retained = writer === "claimed";
    await withContinuation(async (context) => {
      const admission = pauseAdmission();
      const enqueueing = enqueue(context, writer);
      try {
        await admission.entered;
        await removeIdle(exact.sessionKey, undefined, context);
        expect(loadSessionEntry(exact)?.sessionId).toBe("run-123");
      } finally {
        admission.resume();
        await enqueueing;
      }
      expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
        { id: await enqueueing, sessionKey: exact.sessionKey },
      ]);
      await upsertSessionEntryCore(exact, { pinnedAt: retained ? 0 : undefined });
      await removeIdle(exact.sessionKey, undefined, context);
      expect(loadSessionEntry(exact)?.sessionId).toBe("run-123");
      await removeIdle(exact.sessionKey, await enqueueing, context);
      expect(loadSessionEntry(exact)?.sessionId).toBe(retained ? "run-123" : undefined);
      expect(loadSessionEntry(base)?.sessionId).toBe("run-123");
    });
  },
);

it.each(writers)("refuses a %s enqueue that loses to continuation cleanup", async (writer) => {
  await withContinuation(async (context) => {
    const snapshotRead = createDeferredCore();
    const resumeCleanup = createDeferredCore();
    const reserved = createDeferredCore();
    const readPending = queue.loadPendingSessionDeliveries;
    vi.spyOn(queue, "loadPendingSessionDeliveries").mockImplementationOnce(async (owner) => {
      const pending = await readPending(owner);
      snapshotRead.resolve();
      await resumeCleanup.promise;
      return pending;
    });
    const cleaning = removeIdle(exact.sessionKey, undefined, context);
    await snapshotRead.promise;
    const begin = lifecycle.beginSessionEffect;
    vi.spyOn(lifecycle, "beginSessionEffect").mockImplementationOnce((params) => {
      const pending = begin(params);
      reserved.resolve();
      return pending;
    });
    const enqueueing = enqueue(context, writer);
    const refused = expect(enqueueing).rejects.toBeInstanceOf(SessionDeliveryDeadLetteredError);
    try {
      await reserved.promise;
    } finally {
      resumeCleanup.resolve();
      await Promise.all([cleaning, refused]);
    }
    expect(loadSessionEntry(exact)).toBeUndefined();
    expect(loadSessionEntry(base)?.sessionId).toBe("run-123");
    expect(await readPending(context)).toEqual([]);
  });
});

it.each(["live", "removed"] as const)(
  "admits or refuses correlated completion for a %s requester",
  async (requester) => {
    await withContinuation(async (context) => {
      if (requester === "removed") {
        await removeIdle(exact.sessionKey, undefined, context);
      }
      const run = createCorrelatedRun();
      seedSubagentCompletionDelivery({ subagent: run });
      subagentRuns.set(run.runId, run);
      try {
        const publication = admitCorrelatedSubagentSessionDelivery({
          runId: run.runId,
          queueContext: context,
          payload: {
            kind: "agentTurn",
            sessionKey: exact.sessionKey,
            message: "done",
            messageId: "correlated-completion",
          },
        });
        if (requester === "removed") {
          await expect(publication).rejects.toBeInstanceOf(SessionDeliveryDeadLetteredError);
          expect(subagentRuns.get(run.runId)).toEqual(run);
          expect(await queue.loadPendingSessionDeliveries(context)).toEqual([]);
        } else {
          const result = await publication;
          expect(result).toMatchObject({ claimed: true, status: "pending" });
          expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
            {
              id: result.id,
              sessionKey: exact.sessionKey,
              owner: { kind: "subagent_completion", runId: run.runId, generation: 1 },
            },
          ]);
          const delivery = {
            status: "in_progress",
            disposition: "session_queued",
            queueId: result.id,
            generation: 1,
          };
          expect(subagentRuns.get(run.runId)?.delivery).toMatchObject(delivery);
          const database = openOpenClawStateDatabase({ path: context.admission.databasePath });
          expect(readSubagentRun(database, run.runId)?.delivery).toMatchObject(delivery);
          await removeIdle(exact.sessionKey, undefined, context);
          expect(loadSessionEntry(exact)?.sessionId).toBe("run-123");
        }
        expect(loadSessionEntry(base)?.sessionId).toBe("run-123");
      } finally {
        subagentRuns.delete(run.runId);
      }
    });
  },
);

it("refuses correlated announcement publication when its source retires during session admission", async () => {
  await withContinuation(async (context) => {
    const run = createCorrelatedRun();
    subagentRuns.set(run.runId, run);
    saveSubagentRegistryChangesToSqlite(subagentRuns, [run.runId]);
    const database = openOpenClawStateDatabase({ path: context.admission.databasePath });
    const persistedBefore = readSubagentRun(database, run.runId);
    const sourceBefore = structuredClone(run);
    const admission = pauseAdmission();
    let sourceCurrent = true;
    const publication = deliverSubagentAnnouncement({
      requesterSessionKey: exact.sessionKey,
      targetRequesterSessionKey: exact.sessionKey,
      requesterAgentId: "main",
      requesterIsSubagent: false,
      triggerMessage: "generated lighthouse",
      expectsCompletionMessage: true,
      directIdempotencyKey: "correlated-source-authority",
      sourceRunId: run.runId,
      sourceSessionKey: run.childSessionKey,
      sourceTool: "agent_harness_task",
      requesterSessionOrigin: { channel: "discord", to: "channel:media-binding" },
      isSourceSessionAdmissionAllowed: () => sourceCurrent,
      isSourceSessionEffectsAllowed: () => sourceCurrent,
      internalEvents: taskCompletionEvents({
        source: "image_generation",
        childSessionKey: run.childSessionKey,
        result: "generated lighthouse",
        mediaUrls: ["/tmp/synthetic-lighthouse.png"],
      }),
    });
    try {
      await admission.entered;
      expect(await queue.loadPendingSessionDeliveries(context)).toEqual([]);
      sourceCurrent = false;
      admission.resume();
      const outcome = await publication;
      expect.soft(await queue.loadPendingSessionDeliveries(context)).toEqual([]);
      expect.soft(subagentRuns.get(run.runId)).toEqual(sourceBefore);
      expect.soft(readSubagentRun(database, run.runId)).toEqual(persistedBefore);
      expect(outcome).toMatchObject({ delivered: false, disposition: "permanent_failure" });
    } finally {
      admission.resume();
      await publication;
      subagentRuns.delete(run.runId);
    }
  });
});
