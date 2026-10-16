import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorReplica,
  readSessionActorProjectionReceipt,
} from "./session-actor-replica.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import { withSessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts-scope.js";

// mock-isolation: The fixture owns its database and transcript maintenance lifetime.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget maintenance is outside these committed receipt reads.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const question = {
  type: "message",
  id: "question",
  parentId: null,
  message: { role: "user", content: "A question about 🦞" },
};
const answer = {
  type: "message",
  id: "answer",
  parentId: "question",
  message: { role: "assistant", content: "An answer" },
};

const storedBytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;

function seed(f: Fixture, prettyQuestion = false) {
  const header = { type: "session", id: f.scope.sessionId, version: 3, cwd: "/synthetic" };
  const questionJson = JSON.stringify(question, null, prettyQuestion ? 2 : undefined);
  runSqliteImmediateTransactionSync(f.database.db, () => {
    appendTranscriptEventInTransaction(f.database, f.scope, header);
    appendTranscriptEventInTransaction(f.database, f.scope, question, { eventJson: questionJson });
    appendTranscriptEventInTransaction(f.database, f.scope, answer);
  });
  // Native hydration supplies navigation and bytes without retaining transcript payloads.
  f.restartActor();
  return { header, questionJson };
}

function reader(f: Fixture) {
  if (f.target.database.kind !== "file") {
    throw new Error("Context metadata proof requires a durable actor");
  }
  const replica = createSessionActorReplica({
    target: { ...f.target, database: f.target.database },
    lifetime: { assertCurrent() {}, assertReadable() {} },
    currentGeneration: () => "context-metadata-proof",
  });
  const receipt = () => {
    const retained = readSessionActorProjectionReceipt({
      path: f.database.path,
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
    });
    if (!retained) {
      throw new Error("Actor did not publish its projection receipt");
    }
    return retained;
  };
  return {
    replica,
    receipt,
    install() {
      expect(replica.beginRead()(f.read())).toBe(true);
    },
    accounting: () =>
      withSessionTranscriptProjectionReceipt({ ...receipt(), contextOnly: true }, () =>
        readCurrentProjectionSnapshot(f.database, f.scope, (projection) =>
          readSessionTranscriptAccountingFromProjection(projection, {
            includeByteSize: true,
            includeUsage: false,
          }),
        ),
      ),
    bounded: () =>
      withSessionTranscriptProjectionReceipt(receipt(), () =>
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        }),
      ),
  };
}

it("reads rewritten stored bytes from compact receipts and preserves committed totals on rollback", async () => {
  await withActor((f) => {
    const { header, questionJson } = seed(f, true);
    const context = reader(f);
    try {
      context.install();
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      expect(context.accounting()).toMatchObject({
        kind: "value",
        value: {
          eventCount: 2,
          byteSize: Buffer.byteLength(questionJson) + 1 + storedBytes(answer),
        },
      });

      const rewritten = {
        ...question,
        message: { ...question.message, __openclaw: { steerTargetRunId: "committed-next-run" } },
      };
      runSqliteImmediateTransactionSync(f.database.db, () => {
        rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
          { seq: 1, expectedEventJson: questionJson, event: rewritten },
        ]);
      });
      // The compact publication updates exact totals without copying row metadata.
      expect(context.receipt().facts?.contextMetadata).toBeUndefined();
      const expected = { eventCount: 2, byteSize: storedBytes(rewritten) + storedBytes(answer) };
      expect(context.accounting()).toMatchObject({ kind: "value", value: expected });
      expect(context.bounded()).toMatchObject({
        events: [header, rewritten, answer],
        serializedBytes: storedBytes(header) + expected.byteSize,
      });

      const rolledBack = {
        ...rewritten,
        message: {
          ...rewritten.message,
          __openclaw: { steerTargetRunId: "uncommitted-run-with-a-different-size" },
        },
      };
      expect(() =>
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
            { seq: 1, expectedEventJson: JSON.stringify(rewritten), event: rolledBack },
          ]);
          throw new Error("Synthetic context rewrite rollback");
        }),
      ).toThrow("Synthetic context rewrite rollback");
      context.install();
      expect(context.accounting()).toMatchObject({ kind: "value", value: expected });
      expect(context.bounded().events).toEqual([header, rewritten, answer]);
    } finally {
      context.replica.close();
    }
  });
});

it.each(["reset", "compaction", "leaf"] as const)(
  "reads the durable context after %s changes the active window",
  async (kind) => {
    await withActor((f) => {
      const { header } = seed(f);
      const context = reader(f);
      try {
        context.install();
        expect(context.receipt().facts?.contextMetadata).toBeUndefined();
        const control =
          kind === "leaf"
            ? { type: kind, id: "control", parentId: "answer", targetId: "question" }
            : kind === "compaction"
              ? {
                  type: kind,
                  id: "control",
                  parentId: "answer",
                  summary: "The earlier conversation",
                  tokensBefore: 20,
                }
              : { type: kind, id: "control", parentId: "answer", reason: "new" };
        const tail = {
          ...question,
          id: "tail",
          parentId: kind === "leaf" ? "question" : "control",
          message: { role: "user", content: "Continue in the selected window" },
        };
        runSqliteImmediateTransactionSync(f.database.db, () => {
          appendTranscriptEventsInTransaction(f.database, f.scope, [control, tail], {
            scheduleProjectionReconcile: false,
          });
          reconcileSessionTranscriptIndexInTransaction(f.database.db, f.scope.sessionId);
        });
        context.install();
        expect(context.receipt().facts?.contextMetadata).toBeUndefined();
        const counted =
          kind === "reset" ? [tail] : kind === "compaction" ? [control, tail] : [question, tail];
        expect(context.accounting()).toMatchObject({
          kind: "value",
          value: {
            eventCount: counted.length,
            byteSize: counted.reduce((total, event) => total + storedBytes(event), 0),
          },
        });
        const bounded = context.bounded();
        expect(bounded.boundaryCount).toBe(kind === "leaf" ? 0 : 1);
        expect(bounded.events).toEqual(
          kind === "leaf" ? [header, question, tail] : [header, question, answer, control, tail],
        );
      } finally {
        context.replica.close();
      }
    });
  },
);

it("keeps exact accounting through appends and rewrites beyond the actor's resident window without rescanning", async () => {
  await withActor(async (f) => {
    const events = Array.from({ length: 600 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message: { role: "user", content: "x" },
    }));
    runSqliteImmediateTransactionSync(f.database.db, () => {
      appendTranscriptEventsInTransaction(f.database, f.scope, events, {
        scheduleProjectionReconcile: false,
      });
    });
    const context = reader(f);
    try {
      context.install();
      const stats = trackSqliteStatementExecutions(f.database.db, ["aggregate"], (sql) =>
        /\bsum\(/iu.test(sql) && sql.includes('"transcript_events"') ? "aggregate" : null,
      );
      const originalBytes = events.reduce((total, event) => total + storedBytes(event), 0);
      expect(context.accounting()).toMatchObject({
        kind: "value",
        value: {
          eventCount: events.length,
          byteSize: originalBytes,
        },
      });
      const appended = {
        type: "message" as const,
        id: "after-window",
        parentId: events.at(-1)!.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: question.message,
      };
      const command: Mutation = {
        type: "session.actor.appendTranscriptEvent",
        input: {
          target: f.target,
          commandId: "append-after-window",
          phaseId: "append",
          append: {
            kind: "metadata",
            input: {
              scope: f.scope,
              event: appended,
              message: {
                messageJson: JSON.stringify(appended.message),
                cwd: "/synthetic",
                validateTurn: false,
              },
              options: {},
            },
          },
        },
      };
      const rewritten = {
        ...appended,
        message: { ...appended.message, __openclaw: { steerTargetRunId: "new-run" } },
      };
      try {
        await f.prepare(command);
        expect(f.mutate(command)).toMatchObject({ kind: "committed" });
        context.install();
        expect(context.accounting()).toMatchObject({
          kind: "value",
          value: { eventCount: events.length + 1, byteSize: originalBytes + storedBytes(appended) },
        });
        runSqliteImmediateTransactionSync(f.database.db, () => {
          rewriteSqliteTranscriptEventRowsInTransaction(f.database, f.scope, [
            { seq: events.length, expectedEventJson: JSON.stringify(appended), event: rewritten },
          ]);
        });
        expect(context.accounting()).toMatchObject({
          kind: "value",
          value: {
            eventCount: events.length + 1,
            byteSize: originalBytes + storedBytes(rewritten),
          },
        });
        expect(stats.counts.aggregate).toBe(0);
      } finally {
        stats.restore();
      }
      expect(
        readSessionTranscriptBoundedActiveContextCore(f.scope, {
          maxBytes: 1024 * 1024,
          maxEvents: 100,
        }),
      ).toMatchObject({ events: [...events.slice(-99), rewritten], truncated: true });
    } finally {
      context.replica.close();
    }
  });
});
