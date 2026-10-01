import { afterEach, expect, it, vi } from "vitest";
import { deliverSubagentAnnouncement } from "../agents/subagents/announce/subagent-announce-delivery.js";
import { seedSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import { admitCorrelatedSubagentSessionDelivery } from "../agents/subagents/completion/subagent-completion-delivery.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  readSubagentRun,
  saveSubagentRegistryChangesToSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as queue from "../infra/session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "../infra/session-delivery-queue.records.js";
import * as lifecycle from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { removeCronRunContinuationSessionIfIdle } from "./run-continuation-cleanup.js";

const base = { agentId: "main", sessionKey: "agent:main:cron:queue-race" };
const exact = { ...base, sessionKey: `${base.sessionKey}:run:run-123` };
const payload = { kind: "systemEvent" as const, sessionKey: exact.sessionKey, text: "resume" };
const writers = [
  {
    name: "ordinary",
    enqueue: async (context: ReturnType<typeof captureOpenClawStateWorkerContext>) =>
      queue.enqueueSessionDelivery(payload, context),
  },
  {
    name: "claimed",
    enqueue: async (context: ReturnType<typeof captureOpenClawStateWorkerContext>) =>
      (await queue.enqueueClaimedSessionDelivery(payload, 1_000, context)).id,
  },
];

async function seedContinuation() {
  await upsertSessionEntryCore(base, { sessionId: "run-123", updatedAt: 1 });
  await upsertSessionEntryCore(exact, {
    sessionId: "run-123",
    updatedAt: 1,
    cronRunContinuation: { lifecycleRevision: "fixture", phase: "ready", basePersisted: true },
  });
  return captureOpenClawStateWorkerContext();
}

function createCorrelatedRun() {
  const now = Date.now();
  return {
    runId: "correlated-completion",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: exact.sessionKey,
    requesterDisplayKey: exact.sessionKey,
    task: "complete",
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "done", capturedAt: now },
    delivery: { status: "pending" as const, disposition: "retryable" as const },
    cleanup: "keep" as const,
    createdAt: now - 1,
    execution: {
      status: "terminal" as const,
      endedAt: now,
      outcome: { status: "ok" as const },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(writers)("retains the alias while a $name enqueue owns admission", async ({ enqueue }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = await seedContinuation();
    const admitted = createDeferredCore();
    const resume = createDeferredCore();
    const begin = lifecycle.beginSessionWorkAdmission;
    vi.spyOn(lifecycle, "beginSessionWorkAdmission").mockImplementationOnce(async (params) => {
      const lease = await begin(params);
      admitted.resolve();
      await resume.promise;
      return lease;
    });
    const enqueueing = enqueue(context);
    try {
      await admitted.promise;
      await removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context);
      expect(loadSessionEntry(exact)?.sessionId).toBe("run-123");
    } finally {
      resume.resolve();
      await enqueueing;
    }
    expect(await queue.loadPendingSessionDeliveries(context)).toMatchObject([
      { id: await enqueueing, sessionKey: exact.sessionKey },
    ]);
    expect(loadSessionEntry(base)?.sessionId).toBe("run-123");
  });
});

it.each(writers)(
  "refuses a $name enqueue that loses to continuation cleanup",
  async ({ enqueue }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await seedContinuation();
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
      const cleaning = removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context);
      await snapshotRead.promise;
      const begin = lifecycle.beginSessionWorkAdmission;
      vi.spyOn(lifecycle, "beginSessionWorkAdmission").mockImplementationOnce((params) => {
        const pending = begin(params);
        reserved.resolve();
        return pending;
      });
      const enqueueing = enqueue(context);
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
  },
);

it("removes an eligible alias after its own settled delivery, preserving the base", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = await seedContinuation();
    const id = await queue.enqueueSessionDelivery(payload, context);
    await removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context);
    expect(loadSessionEntry(exact)?.sessionId).toBe("run-123");
    await removeCronRunContinuationSessionIfIdle(exact.sessionKey, id, context);
    expect(loadSessionEntry(exact)).toBeUndefined();
    expect(loadSessionEntry(base)?.sessionId).toBe("run-123");
  });
});

it.each(["live", "removed"] as const)(
  "admits or refuses correlated completion for a %s requester",
  async (requester) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await seedContinuation();
      if (requester === "removed") {
        await removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context);
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
          await removeCronRunContinuationSessionIfIdle(exact.sessionKey, undefined, context);
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
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = await seedContinuation();
    const run = createCorrelatedRun();
    subagentRuns.set(run.runId, run);
    saveSubagentRegistryChangesToSqlite(subagentRuns, [run.runId]);
    const database = openOpenClawStateDatabase({ path: context.admission.databasePath });
    const persistedBefore = readSubagentRun(database, run.runId);
    const sourceBefore = structuredClone(run);
    const admitted = createDeferredCore();
    const resume = createDeferredCore();
    const begin = lifecycle.beginSessionWorkAdmission;
    vi.spyOn(lifecycle, "beginSessionWorkAdmission").mockImplementationOnce(async (params) => {
      const lease = await begin(params);
      admitted.resolve();
      await resume.promise;
      return lease;
    });
    let sourceCurrent = true;
    const publication = deliverSubagentAnnouncement({
      requesterSessionKey: exact.sessionKey,
      targetRequesterSessionKey: exact.sessionKey,
      requesterAgentId: "main",
      requesterIsSubagent: false,
      triggerMessage: "generated lighthouse",
      steerMessage: "generated lighthouse",
      expectsCompletionMessage: true,
      directIdempotencyKey: "correlated-source-authority",
      sourceRunId: run.runId,
      sourceSessionKey: run.childSessionKey,
      sourceTool: "agent_harness_task",
      requesterSessionOrigin: { channel: "discord", to: "channel:media-binding" },
      isSourceSessionAdmissionAllowed: () => sourceCurrent,
      isSourceSessionEffectsAllowed: () => sourceCurrent,
      internalEvents: [
        {
          type: "task_completion",
          source: "image_generation",
          childSessionKey: run.childSessionKey,
          announceType: "image generation",
          taskLabel: "lighthouse",
          status: "ok",
          statusLabel: "completed",
          result: "generated lighthouse",
          mediaUrls: ["/tmp/synthetic-lighthouse.png"],
          replyInstruction: "Deliver the generated image.",
        },
      ],
    });
    try {
      await admitted.promise;
      expect(await queue.loadPendingSessionDeliveries(context)).toEqual([]);
      sourceCurrent = false;
      resume.resolve();
      const outcome = await publication;
      expect.soft(await queue.loadPendingSessionDeliveries(context)).toEqual([]);
      expect.soft(subagentRuns.get(run.runId)).toEqual(sourceBefore);
      expect.soft(readSubagentRun(database, run.runId)).toEqual(persistedBefore);
      expect(outcome).toMatchObject({ delivered: false, disposition: "permanent_failure" });
    } finally {
      resume.resolve();
      await publication;
      subagentRuns.delete(run.runId);
    }
  });
});
