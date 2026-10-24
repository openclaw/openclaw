import { assert, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readActivitySummaryBatchFromReplica } from "../../gateway/session-activity-summary-replica.js";
import { readActivitySummarySource } from "../../gateway/session-activity-summary-source.js";
import { readActivitySummaryBatch } from "../../gateway/session-activity-summary-source.worker.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  deleteSessionEntryRows,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { mutateSqliteSessionAtMessageInTransaction } from "./session-accessor.sqlite-message-cut.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { replaceSqliteTranscriptSuffixInTransaction } from "./session-accessor.sqlite-transcript-suffix.js";
import {
  createSessionActorReplica,
  readSessionActorTranscriptAnchorsFromReplica,
  readSessionActorTranscriptReplica,
  retainSessionActorTranscriptReplica,
} from "./session-actor-replica.js";
import {
  readSessionActorTranscriptContext,
  seedSessionActorTranscriptContext,
} from "./session-actor-transcript-replica.js";
import { summaryFacts, transcriptTurnCommand } from "./session-actor-transcript.test-support.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdBatchInWorker,
  prepareSessionColdRestoreInWorker,
} from "./session-cold-storage-worker.js";
import { readRetainedSessionEntryFacts } from "./session-entry-read-facts.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { readPreparedSessionTranscriptChange } from "./session-transcript-authority.js";

// mock-isolation: The fixture owns its database and transcript maintenance lifetime.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture controls archival rather than launching disk-budget maintenance.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const limits = { maxBytes: 1024 * 1024, maxEvents: 100 };
const question = {
  type: "message",
  id: "question",
  parentId: null,
  timestamp: "2026-01-01T00:00:01Z",
  message: { role: "user", content: "Original question" },
};
const answer = {
  type: "message",
  id: "answer",
  parentId: "question",
  timestamp: "2026-01-01T00:00:02Z",
  message: { role: "assistant", content: "Original answer" },
};

function transcript(f: Fixture) {
  return [
    {
      type: "session",
      id: f.scope.sessionId,
      version: 3,
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/synthetic",
    },
    question,
    answer,
  ];
}

function replace(f: Fixture) {
  runSqliteImmediateTransactionSync(f.database.db, () => {
    writeSessionEntry(f.database, f.target.sessionKey, {
      sessionId: f.scope.sessionId,
      updatedAt: 1,
    });
    replaceSqliteTranscriptEventsInTransaction(f.database, f.scope, transcript(f));
  });
}

function contextFixture(f: Fixture) {
  assert(
    f.target.database.kind === "file",
    "Transcript residency fixture requires a durable actor",
  );
  const replica = createSessionActorReplica({
    target: { ...f.target, database: f.target.database },
    lifetime: { assertCurrent() {}, assertReadable() {} },
    currentGeneration: () => "fixture-worker",
  });
  const seed = () => {
    let residentRows: Extract<
      PreparedSessionTranscriptHydration,
      { kind: "bounded" }
    >["residentRows"];
    const snapshot = readSessionTranscriptBoundedActiveContextCore(f.scope, {
      ...limits,
      onRead: (_projection, rows) => {
        residentRows = rows;
      },
    });
    const hot = f.read();
    expect(replica.beginRead()(hot)).toBe(true);
    const retained = seedSessionActorTranscriptContext(
      undefined,
      hot,
      { kind: "bounded", snapshot, residentRows },
      limits,
    );
    assert(retained, "Canonical bounded read did not seed transcript residency");
    retainSessionActorTranscriptReplica(hot, retained);
    return hot;
  };
  const selection = { entryIds: ["question", "answer"], includeWatermark: true };
  return {
    replica,
    seed,
    anchors: () =>
      readSessionActorTranscriptAnchorsFromReplica(
        { ...f.scope, path: f.database.path },
        selection,
      ),
    canonicalAnchors: () =>
      readSessionTranscriptAnchorFactsInDatabase(f.database, f.scope, selection),
    summary: () => readActivitySummaryBatchFromReplica({ scope: f.scope }),
    read() {
      const hot = replica.read();
      return (
        hot &&
        readSessionActorTranscriptContext(readSessionActorTranscriptReplica(hot), hot, limits)
      );
    },
  };
}

async function withContext(
  run: (f: Fixture, context: ReturnType<typeof contextFixture>) => void | Promise<void>,
) {
  await withActor(async (f) => {
    replace(f);
    const context = contextFixture(f);
    try {
      await run(f, context);
    } finally {
      context.replica.close();
    }
  });
}

function expectInvalidated(context: ReturnType<typeof contextFixture>, change?: string) {
  expect(context.read(), change).toBeUndefined();
  expect(context.anchors(), change).toBeUndefined();
  expect(context.summary(), change).toBeUndefined();
}

function expectProjections(
  context: ReturnType<typeof contextFixture>,
  events = [question, answer],
) {
  expect(context.anchors()).toBeUndefined();
  expect(context.canonicalAnchors().anchors.map((anchor) => anchor.entryId)).toEqual([
    "question",
    "answer",
  ]);
  expect(context.summary()?.page.events.map(({ event }) => event)).toEqual(events);
}

function storedEvents(f: Fixture) {
  return readTranscriptEventRows(f.database, f.scope.sessionId).map((row) =>
    JSON.parse(row.eventJson),
  );
}

function appendEvent(f: Fixture, event: Record<string, unknown> & { id: string }) {
  return f.mutate({
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: f.target,
      commandId: event.id,
      phaseId: "turn",
      sessionId: f.scope.sessionId,
      lifecycleRevision: null,
      eventJson: JSON.stringify(event),
    },
  });
}

function expectAppended(outcome: ReturnType<Fixture["mutate"]>, event: object) {
  expect(outcome).toMatchObject({
    kind: "committed",
    receipt: { transcript: { appendedEvents: [{ event }] } },
  });
}

const correlation = (steerTargetRunId: string) => ({
  ...question,
  message: { ...question.message, __openclaw: { steerTargetRunId } },
});

it("keeps settled append bodies in receipts and storage without evicting navigation", () =>
  withActor((f) => {
    replace(f);
    const other = { ...f.target, sessionKey: "agent:main:other-resident" };
    runSqliteImmediateTransactionSync(f.database.db, () => {
      writeSessionEntry(f.database, other.sessionKey, { sessionId: "other", updatedAt: 1 });
    });
    const warn = vi.fn();
    f.hooks.transactionOptions = { logger: { warn }, slowTransactionHoldMs: 0 };
    const events = Array.from({ length: 6 }, (_, index) => ({
      type: "custom",
      id: `large-metadata-${index}`,
      parentId: index === 0 ? "answer" : `large-metadata-${index - 1}`,
      timestamp: "2026-01-01T00:00:03Z",
      customType: "openclaw.cache-ttl",
      data: { snapshot: "synthetic".repeat(180_000) },
    }));
    for (const [index, event] of events.entries()) {
      const outcome = appendEvent(f, event);
      expect(outcome.kind).toBe("committed");
      expect(warn).toHaveBeenLastCalledWith(
        "slow SQLite transaction hold",
        expect.objectContaining({
          operation: "session.actor.appendTranscriptEvent",
          context: {
            payloadBytes: Buffer.byteLength(JSON.stringify(event)),
            actorResident: index > 0,
            actorTranscriptEvents: 3 + index,
            actorActiveEvents: 2 + index,
            actorReadMs: expect.any(Number),
            actorApplyMs: expect.any(Number),
            actorProjectionMs: expect.any(Number),
            actorReceiptMs: expect.any(Number),
            actorReceiptBytes: expect.any(Number),
          },
        }),
      );
      if (outcome.kind === "committed") {
        expect(outcome.receipt.transcript.appendedEvents?.[0]?.event).toEqual(event);
      }
    }
    const expectedBytes = [...transcript(f), ...events].reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    );
    const reads = trackSqliteStatementExecutions(f.database.db, ["history"], (sql) =>
      /^\s*select\b/iu.test(sql) && sql.includes('"transcript_events"') ? "history" : null,
    );
    let warm;
    try {
      f.read(other);
      reads.counts.history = 0;
      warm = f.read();
      expect(reads.counts.history).toBe(0);
      expect(warm.transcript.projection?.contextMetadata).toBeUndefined();
    } finally {
      reads.restore();
    }
    expect(storedEvents(f)).toEqual([...transcript(f), ...events]);
    f.restartActor();
    const cold = f.read();
    expect(cold.transcript.modelContext).toEqual(warm.transcript.modelContext);
    expect(cold.transcript.projection?.contextMetadata).toBeUndefined();
    expect(
      readSessionTranscriptBoundedActiveContextCore(f.scope, {
        maxBytes: expectedBytes,
        maxEvents: 100,
      }).serializedBytes,
    ).toBe(expectedBytes);
  }));

it.each(["warm", "restarted"] as const)(
  "preserves tree cursors and complete append bodies in a %s actor",
  async (residency) => {
    await withActor((f) => {
      const replayMessage = { ...question.message, idempotencyKey: "cursor-probe" };
      const initial = transcript(f);
      initial[1] = { ...question, message: replayMessage };
      runSqliteImmediateTransactionSync(f.database.db, () => {
        replaceSqliteTranscriptEventsInTransaction(f.database, f.scope, initial);
      });
      f.read();
      const append = (event: Record<string, unknown> & { id: string }) => {
        expectAppended(appendEvent(f, event), event);
      };
      let command = 0;
      const appendMessage = (message: typeof replayMessage) => {
        if (residency === "restarted") {
          f.restartActor();
        }
        return f.mutate({
          type: "session.actor.appendToolResult",
          input: {
            target: f.target,
            commandId: `message-${command++}`,
            phaseId: "turn",
            append: {
              kind: "message",
              input: { scope: f.scope, messageJson: JSON.stringify(message), cwd: "/synthetic" },
            },
          },
        });
      };
      const expectVisibleTail = (entryId: string) => {
        expect(appendMessage(replayMessage)).toMatchObject({
          kind: "committed",
          value: {
            kind: "message",
            value: {
              snapshot: {
                ok: true,
                value: {
                  result: { appended: false, messageId: "question", message: replayMessage },
                  visibleTail: { entryId },
                },
              },
            },
          },
        });
      };
      const side = {
        type: "custom",
        id: "side",
        parentId: "answer",
        appendMode: "side",
        customType: "synthetic-side-state",
        data: { body: "Preserve the entire side payload. ".repeat(100) },
      };
      append(side);
      expectVisibleTail("answer");
      const leaf = {
        type: "leaf",
        id: "selected-leaf",
        parentId: "side",
        targetId: "question",
        appendParentId: "answer",
      };
      append(leaf);
      expectVisibleTail("question");
      const continued = {
        ...replayMessage,
        content: "Continue the selected branch",
        idempotencyKey: "continued",
      };
      expectAppended(appendMessage(continued), { parentId: "answer", message: continued });
      const parentless = {
        type: "custom",
        id: "parentless",
        customType: "synthetic-parentless-state",
        data: { body: "Keep the missing parent field and this payload" },
      };
      append(parentless);
      expectVisibleTail("parentless");
      const following = {
        ...replayMessage,
        content: "Follow the parentless entry",
        idempotencyKey: "following",
      };
      expectAppended(appendMessage(following), { parentId: "parentless", message: following });
      expect(storedEvents(f)).toEqual([
        ...initial,
        side,
        leaf,
        expect.objectContaining({ type: "message", parentId: "answer", message: continued }),
        parentless,
        expect.objectContaining({ type: "message", parentId: "parentless", message: following }),
      ]);
    });
  },
);

it("advances retained context through native actor appends and preserves it through bookkeeping", () =>
  withContext(async (f, context) => {
    const initial = context.seed();
    expect(context.read()?.snapshot.events).toEqual(transcript(f));
    const command: Mutation = {
      type: "session.actor.appendToolResult",
      input: {
        target: f.target,
        expected: initial.version,
        ...transcriptTurnCommand(f.scope, "next-turn", [
          { eventId: "next-question", message: { role: "user", content: "Next question" }, now: 4 },
          {
            eventId: "next-answer",
            message: { role: "assistant", content: "Next answer" },
            now: 5,
          },
        ]),
      },
    };
    await f.prepare(command);
    const pending = context.replica.beginCommand();
    const appended = f.mutate(command);
    expect(appended.kind).toBe("committed");
    expect(pending.settle<unknown>(appended)).toBe(true);
    const reads = trackSqliteStatementExecutions(f.database.db, ["read"], (sql) =>
      /^\s*select\b/iu.test(sql) ? "read" : null,
    );
    try {
      for (let call = 0; call < 2; call += 1) {
        expect(context.read()?.snapshot.events).toEqual([
          ...transcript(f),
          expect.objectContaining({
            id: "next-question",
            message: expect.objectContaining({ role: "user", content: "Next question" }),
          }),
          expect.objectContaining({
            id: "next-answer",
            message: expect.objectContaining({ role: "assistant", content: "Next answer" }),
          }),
        ]);
      }
      expect(reads.counts.read).toBe(0);
    } finally {
      reads.restore();
    }
    const current = context.replica.read()!;
    const bookkeeping = context.replica.beginCommand();
    expect(
      bookkeeping.settle<unknown>(
        f.mutate({
          type: "session.actor.patch",
          input: {
            target: f.target,
            expected: current.version,
            commandId: "accounting",
            phaseId: "turn",
            reducers: [{ kind: "activity", updatedAt: 6 }],
          },
        }),
      ),
    ).toBe(true);
    expect(context.read()?.snapshot.events).toHaveLength(5);
    expect(context.anchors()).toBeUndefined();
    expect(context.canonicalAnchors().watermark).toEqual(
      context.replica.read()!.transcript.watermark,
    );
    expect(context.summary()?.page.events).toHaveLength(4);
    expect(context.summary()?.page.events.at(-1)?.event).toMatchObject({
      id: "next-answer",
      message: { content: "Next answer" },
    });
  }));

it("settles a resident correlation rewrite once and leaves rollback payloads unchanged", () =>
  withContext((f, context) => {
    const publications: unknown[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      const fact = readPreparedSessionTranscriptChange(change);
      if (fact?.kind === "postimage" && fact.value.sessionKey === f.scope.sessionKey) {
        publications.push(fact.value);
      }
    });
    try {
      context.seed();
      const row = readTranscriptEventRows(f.database, f.scope.sessionId)[1]!;
      const rewritten = correlation("next-run");
      const rewrite = (event = rewritten, expectedEventJson = row.eventJson) =>
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: row.seq, expectedEventJson, event },
        ]);
      expect(() =>
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewrite();
          expect(publications).toEqual([]);
          throw new Error("Synthetic rewrite rollback");
        }),
      ).toThrow("Synthetic rewrite rollback");
      expect(publications).toEqual([]);
      expectInvalidated(context);
      expect(readSessionTranscriptBoundedActiveContextCore(f.scope, limits).events).toEqual(
        transcript(f),
      );
      const before = context.seed();
      expect(context.read()?.snapshot.events).toEqual(transcript(f));

      runSqliteImmediateTransactionSync(f.database.db, () => rewrite());
      expect(publications).toHaveLength(1);
      expect(context.read()?.snapshot.events).toEqual([transcript(f)[0], rewritten, answer]);
      expectProjections(context, [rewritten, answer]);
      expect(f.read().version).toEqual({
        ...before.version,
        sequence: before.version.sequence + 1,
      });
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)[1]?.eventJson).toBe(
        JSON.stringify(rewritten),
      );

      const intermediate = correlation("intermediate");
      const final = correlation("final");
      publications.length = 0;
      runSqliteImmediateTransactionSync(f.database.db, () => {
        rewrite(intermediate, JSON.stringify(rewritten));
        rewrite(final, JSON.stringify(intermediate));
      });
      expect(publications).toHaveLength(2);
      expectInvalidated(context);
      const reloaded = f.read();
      const canonical = readSessionTranscriptBoundedActiveContextCore(f.scope, limits);
      expect(reloaded.transcript.version).toEqual(canonical.version);
      expect(reloaded.version.epoch).not.toBe(before.version.epoch);
      context.seed();
      expect(context.read()?.snapshot.events).toEqual([transcript(f)[0], final, answer]);
    } finally {
      stop();
    }
  }));

it("invalidates retained context for nonactor content and topology writer classes", () =>
  withContext(async (f, context) => {
    for (const change of [
      "append",
      "rewrite",
      "replacement",
      "suffix-trim",
      "rewind",
      "compaction",
      "reset",
      "delete",
    ] as const) {
      replace(f);
      const before = context.seed();
      expect(context.read()?.snapshot.events).toEqual(transcript(f));
      expectProjections(context);
      runSqliteImmediateTransactionSync(f.database.db, () => {
        if (change === "append") {
          appendTranscriptEventsInTransaction(f.database, f.scope, [
            { ...answer, id: "new-answer", parentId: "answer" },
          ]);
        } else if (change === "rewrite") {
          const row = readTranscriptEventRows(f.database, f.scope.sessionId)[1]!;
          rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
            {
              seq: row.seq,
              expectedEventJson: row.eventJson,
              event: {
                ...question,
                message: { ...question.message, content: "Rewritten question" },
              },
            },
          ]);
        } else if (change === "replacement") {
          replaceSqliteTranscriptEventsInTransaction(f.database, f.scope, [
            transcript(f)[0]!,
            { ...question, message: { role: "user", content: "Replacement question" } },
          ]);
        } else if (change === "suffix-trim") {
          replaceSqliteTranscriptSuffixInTransaction(f.database, f.scope, {
            expectedEvents: transcript(f),
            nextEvents: transcript(f).slice(0, 2),
            persistedPrefixLength: 2,
          });
        } else if (change === "rewind") {
          expect(
            mutateSqliteSessionAtMessageInTransaction(f.database, f.scope, {
              mode: "rewind",
              sourceKey: f.target.sessionKey,
              canonicalSourceKey: f.target.sessionKey,
              targetKey: f.target.sessionKey,
              entryId: "question",
              expectedState: before.entry,
            }).status,
          ).toBe("created");
        } else if (change === "delete") {
          deleteSessionEntryRows(f.database, f.target.sessionKey, { deleteOwnedWindows: true });
        } else {
          appendTranscriptEventsInTransaction(f.database, f.scope, [
            {
              type: change,
              id: "boundary",
              parentId: "answer",
              timestamp: "2026-01-01T00:00:03Z",
              firstKeptEntryId: "question",
              summary: "Summary",
              tokensBefore: 10,
              reason: "reset",
            },
          ]);
        }
      });
      expectInvalidated(context, change);
      const after = f.read();
      if (change === "rewrite") {
        expect(readTranscriptEventRows(f.database, f.scope.sessionId)[1]?.eventJson).toContain(
          "Rewritten question",
        );
      } else if (change === "replacement" || change === "suffix-trim") {
        expect(readTranscriptEventRows(f.database, f.scope.sessionId)).toHaveLength(2);
      } else if (change === "rewind") {
        expect(after.entry?.sessionId).not.toBe(before.entry?.sessionId);
      } else if (change === "delete") {
        expect(after.entry).toBeUndefined();
      } else {
        expect(after.transcript.version.rawSeq).toBe(before.transcript.version.rawSeq! + 1);
      }
      expect(context.replica.beginRead()(after), change).toBe(true);
      expect(context.read(), change).toBeUndefined();
      if (change === "rewrite" || change === "rewind" || change === "compaction") {
        const scope = { ...f.scope, sessionId: after.entry!.sessionId };
        const source = await readActivitySummarySource({ scope, assertCurrent() {} });
        const canonical = readActivitySummaryBatch({ scope });
        expect(summaryFacts(source), change).toEqual(summaryFacts(canonical));
        expect(source?.notes, change).toEqual(
          change === "rewind"
            ? []
            : [
                `user: ${change === "rewrite" ? "Rewritten" : "Original"} question`,
                "assistant: Original answer",
              ],
        );
      }
    }
  }));

it("drops retained context on cold archival and leaves restoration to a fresh bounded read", () =>
  withContext(async (f, context) => {
    context.seed();
    const databaseOptions = { agentId: "main", path: f.database.path };
    const readColdMetadata = () =>
      readRetainedSessionEntryFacts(databaseOptions, {
        sessionKeys: [f.target.sessionKey],
        includeColdMetadata: true,
      });
    expect(readColdMetadata()?.coldArchives).toEqual([]);
    const beforeMs = Date.UTC(2030, 0, 1);
    const prepared = await prepareSessionColdBatchInWorker({
      databaseOptions,
      beforeMs,
      admissionIdentities: [],
      liveSessionKeys: [],
      cooledSessionIds: [],
      maxTranscripts: 1,
      maxBytes: 1024 * 1024,
    });
    expect(prepared.prepared).toHaveLength(1);
    expect(
      mutateSessionColdTranscriptInWorker(
        {
          kind: "cold-batch",
          databaseOptions,
          beforeMs,
          prepared: prepared.prepared,
          externalizations: [],
          protectionKeys: prepared.protectionKeys,
          liveSessionKeys: [],
        },
        undefined,
        () => {},
      ),
    ).toMatchObject({ archivedTranscripts: 1 });
    expectInvalidated(context);
    expect(readColdMetadata()).toBeUndefined();
    expect(context.replica.beginRead()(f.read())).toBe(true);
    expect(readColdMetadata()).toBeUndefined();
    const plan = {
      kind: "cold-restore" as const,
      databaseOptions,
      sessionId: f.scope.sessionId,
      archive: prepared.prepared[0]!.archive,
    };
    const records = await prepareSessionColdRestoreInWorker(plan);
    expect(mutateSessionColdTranscriptInWorker(plan, records, () => {})).toMatchObject({
      restored: true,
    });
    expectInvalidated(context);
    expect(readColdMetadata()).toBeUndefined();
    context.seed();
    expect(readColdMetadata()?.coldArchives).toEqual([]);
    expect(context.read()?.snapshot.events).toEqual(transcript(f));
    expectProjections(context);
  }));
