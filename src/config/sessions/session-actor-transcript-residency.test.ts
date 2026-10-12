import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readActivitySummaryBatchFromReplica } from "../../gateway/session-activity-summary-replica.js";
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
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdBatchInWorker,
  prepareSessionColdRestoreInWorker,
} from "./session-cold-storage-worker.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";
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
  if (f.target.database.kind !== "file") {
    throw new Error("Transcript residency fixture requires a durable actor");
  }
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
    expect(replica.beginRead().install(hot)).toBe(true);
    const retained = seedSessionActorTranscriptContext(
      undefined,
      hot,
      { kind: "bounded", snapshot, residentRows },
      limits,
    );
    if (!retained) {
      throw new Error("Canonical bounded read did not seed transcript residency");
    }
    retainSessionActorTranscriptReplica(hot, retained);
    return hot;
  };
  return {
    replica,
    seed,
    anchors() {
      return readSessionActorTranscriptAnchorsFromReplica(
        { ...f.scope, path: f.database.path },
        { entryIds: ["question", "answer"], includeWatermark: true },
      );
    },
    summary() {
      return readActivitySummaryBatchFromReplica({ scope: f.scope });
    },
    read() {
      const hot = replica.read();
      return (
        hot &&
        readSessionActorTranscriptContext(readSessionActorTranscriptReplica(hot), hot, limits)
      );
    },
  };
}

it("advances retained context through native actor appends and preserves it through bookkeeping", async () => {
  await withActor(async (f) => {
    replace(f);
    const context = contextFixture(f);
    try {
      const initial = context.seed();
      expect(context.read()?.snapshot.events).toEqual(transcript(f));
      const command: Mutation = {
        type: "session.actor.appendToolResult",
        input: {
          target: f.target,
          expected: initial.version,
          commandId: "next-turn",
          phaseId: "turn",
          turn: {
            agentId: "main",
            sessionKey: f.target.sessionKey,
            options: {
              expectedSessionId: f.scope.sessionId,
              sessionFile: "synthetic.jsonl",
              messages: [
                {
                  eventId: "next-question",
                  message: { role: "user", content: "Next question" },
                  now: 4,
                },
                {
                  eventId: "next-answer",
                  message: { role: "assistant", content: "Next answer" },
                  now: 5,
                },
              ],
            },
          },
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
      expect(context.anchors()?.watermark).toEqual(context.replica.read()!.transcript.watermark);
      expect(context.summary()?.page.events).toHaveLength(4);
      expect(context.summary()?.page.events.at(-1)?.event).toMatchObject({
        id: "next-answer",
        message: { content: "Next answer" },
      });
    } finally {
      context.replica.close();
    }
  });
});

it("settles a resident correlation rewrite once and leaves rollback payloads unchanged", async () => {
  await withActor((f) => {
    replace(f);
    const context = contextFixture(f);
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
      const rewritten = {
        ...question,
        message: { ...question.message, __openclaw: { steerTargetRunId: "next-run" } },
      };
      const rewrite = () =>
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: row.seq, expectedEventJson: row.eventJson, event: rewritten },
        ]);
      expect(() =>
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewrite();
          expect(publications).toEqual([]);
          throw new Error("Synthetic rewrite rollback");
        }),
      ).toThrow("Synthetic rewrite rollback");
      expect(publications).toEqual([]);
      expect(context.read()).toBeUndefined();
      expect(context.anchors()).toBeUndefined();
      expect(context.summary()).toBeUndefined();
      expect(readSessionTranscriptBoundedActiveContextCore(f.scope, limits).events).toEqual(
        transcript(f),
      );
      const before = context.seed();
      expect(context.read()?.snapshot.events).toEqual(transcript(f));

      runSqliteImmediateTransactionSync(f.database.db, rewrite);
      expect(publications).toHaveLength(1);
      expect(context.read()?.snapshot.events).toEqual([transcript(f)[0], rewritten, answer]);
      expect(context.anchors()?.anchors.map((anchor) => anchor.entryId)).toEqual([
        "question",
        "answer",
      ]);
      expect(context.summary()?.page.events.map(({ event }) => event)).toEqual([rewritten, answer]);
      expect(f.read().version).toEqual({
        ...before.version,
        sequence: before.version.sequence + 1,
      });
      expect(readTranscriptEventRows(f.database, f.scope.sessionId)[1]?.eventJson).toBe(
        JSON.stringify(rewritten),
      );

      const intermediate = {
        ...question,
        message: { ...question.message, __openclaw: { steerTargetRunId: "intermediate" } },
      };
      const final = {
        ...question,
        message: { ...question.message, __openclaw: { steerTargetRunId: "final" } },
      };
      publications.length = 0;
      runSqliteImmediateTransactionSync(f.database.db, () => {
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: row.seq, expectedEventJson: JSON.stringify(rewritten), event: intermediate },
        ]);
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: row.seq, expectedEventJson: JSON.stringify(intermediate), event: final },
        ]);
      });
      expect(publications).toHaveLength(2);
      expect(context.read()).toBeUndefined();
      expect(context.anchors()).toBeUndefined();
      expect(context.summary()).toBeUndefined();
      const reloaded = f.read();
      const canonical = readSessionTranscriptBoundedActiveContextCore(f.scope, limits);
      expect(reloaded.transcript.version).toEqual(canonical.version);
      expect(reloaded.version.epoch).not.toBe(before.version.epoch);
      context.seed();
      expect(context.read()?.snapshot.events).toEqual([transcript(f)[0], final, answer]);
    } finally {
      stop();
      context.replica.close();
    }
  });
});

it("invalidates retained context for nonactor content and topology writer classes", async () => {
  await withActor((f) => {
    const context = contextFixture(f);
    try {
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
        expect(context.anchors()?.anchors.map((anchor) => anchor.entryId)).toEqual([
          "question",
          "answer",
        ]);
        expect(context.summary()?.page.events.map(({ event }) => event)).toEqual([
          question,
          answer,
        ]);
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
        expect(context.read(), change).toBeUndefined();
        expect(context.anchors(), change).toBeUndefined();
        expect(context.summary(), change).toBeUndefined();
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
        expect(context.replica.beginRead().install(after), change).toBe(true);
        expect(context.read(), change).toBeUndefined();
      }
    } finally {
      context.replica.close();
    }
  });
});

it("drops retained context on cold archival and leaves restoration to a fresh bounded read", async () => {
  await withActor(async (f) => {
    replace(f);
    const context = contextFixture(f);
    try {
      context.seed();
      const databaseOptions = { agentId: "main", path: f.database.path };
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
      expect(context.read()).toBeUndefined();
      expect(context.anchors()).toBeUndefined();
      expect(context.summary()).toBeUndefined();
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
      expect(context.read()).toBeUndefined();
      expect(context.anchors()).toBeUndefined();
      expect(context.summary()).toBeUndefined();
      context.seed();
      expect(context.read()?.snapshot.events).toEqual(transcript(f));
      expect(context.anchors()?.anchors.map((anchor) => anchor.entryId)).toEqual([
        "question",
        "answer",
      ]);
      expect(context.summary()?.page.events.map(({ event }) => event)).toEqual([question, answer]);
    } finally {
      context.replica.close();
    }
  });
});
