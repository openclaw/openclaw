import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function message(id: string, parentId: string | null, timestamp: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: id, idempotencyKey: id },
  };
}

it("batches bounded inserts while preserving order and subsequent identity rejection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, events } = createSessionCompoundWorkerFixture();
    const rows = Array.from({ length: 130 }, (_, index) =>
      message(`row-${index}`, index === 0 ? null : `row-${index - 1}`, index + 1),
    );
    const writes = trackSqliteStatementExecutions(
      database.db,
      ["identities", "payloads", "active", "identityReads", "ftsIdentities", "ftsContent"],
      (sql) => {
        if (/^insert into "session_transcript_fts_rows"/i.test(sql)) {
          return "ftsIdentities";
        }
        if (sql.includes('insert into "session_transcript_fts"')) {
          return "ftsContent";
        }
        if (/^insert into "transcript_event_identities"/i.test(sql)) {
          return "identities";
        }
        if (/^insert into "transcript_events"/i.test(sql)) {
          return "payloads";
        }
        if (/^insert into "session_transcript_active_events"/i.test(sql)) {
          return "active";
        }
        return /^select /i.test(sql) && sql.includes('from "transcript_event_identities"')
          ? "identityReads"
          : null;
      },
    );
    try {
      runOpenClawAgentWriteTransaction(
        () => expect(appendTranscriptEventsInTransaction(database, scope, rows)).toBe(130),
        { agentId: "main", path: database.path },
      );
      expect(writes.counts).toEqual({
        identities: 3,
        payloads: 3,
        active: 3,
        identityReads: 1,
        ftsIdentities: 3,
        ftsContent: 3,
      });
    } finally {
      writes.restore();
    }
    runOpenClawAgentWriteTransaction(
      () => {
        expect(appendTranscriptEventInTransaction(database, scope, rows[64]!)).toBe(false);
        expect(
          appendTranscriptEventsInTransaction(database, scope, [
            rows[129]!,
            message("tail", "row-129", 200),
          ]),
        ).toBe(1);
      },
      { agentId: "main", path: database.path },
    );
    expect(events().map((event) => event.id)).toEqual([...rows.map((row) => row.id), "tail"]);
    expect(
      database.db
        .prepare(
          "SELECT message_id FROM session_transcript_fts WHERE session_id = ? AND session_transcript_fts MATCH 'row OR tail' ORDER BY rowid",
        )
        .all(scope.sessionId),
    ).toEqual([...rows.map((row) => row.id), "tail"].map((message_id) => ({ message_id })));
    expect(
      database.db
        .prepare(
          "SELECT event_id, seq FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
        )
        .all(scope.sessionId),
    ).toEqual([...rows, { id: "tail" }].map((row, seq) => ({ event_id: row.id, seq })));
  });
});

it.each(
  (["dedupe", "preserve-owner", "relocate-owner"] as const).flatMap((mode) =>
    (["prepared-array", "streaming"] as const).map((source) => ({ mode, source })),
  ),
)(
  "preserves $mode key ownership within buffered rows and across flushes for $source",
  async ({ mode, source }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope, events } = createSessionCompoundWorkerFixture();
      const write = (run: () => void) =>
        runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path });
      const seed = message("seed", null, 1);
      seed.message.idempotencyKey = "seeded";
      write(() => {
        appendTranscriptEventInTransaction(database, scope, seed);
      });
      const rows = Array.from({ length: 70 }, (_, index) =>
        message(`row-${index}`, null, index + 2),
      );
      for (const index of [0, 1, 69]) {
        rows[index]!.message.idempotencyKey = "shared";
      }
      for (const index of [2, 68]) {
        rows[index]!.message.idempotencyKey = "seeded";
      }
      // The source needs accurate feedback while the accepted prefix is still buffered.
      const accepted: boolean[] = [];
      function* streamRows(): Generator<ReturnType<typeof message>, void, boolean> {
        for (const row of rows) {
          accepted.push(yield row);
        }
      }
      write(() => {
        expect(
          appendTranscriptEventsInTransaction(
            database,
            scope,
            source === "prepared-array" ? rows : streamRows(),
            { idempotencyKeyMode: mode },
          ),
        ).toBe(mode === "dedupe" ? 66 : 70);
      });
      const expectedAccepted = rows.map(
        (_, index) => mode !== "dedupe" || ![1, 2, 68, 69].includes(index),
      );
      expect(accepted).toEqual(source === "streaming" ? expectedAccepted : []);
      expect(events().map((event) => event.id)).toEqual([
        "seed",
        ...rows.filter((_, index) => expectedAccepted[index]).map((row) => row.id),
      ]);
      expect(
        database.db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND message_idempotency_key IN (?, ?) ORDER BY message_idempotency_key",
          )
          .all(scope.sessionId, "shared", "seeded"),
      ).toEqual([
        {
          event_id: mode === "relocate-owner" ? "row-68" : "seed",
          message_idempotency_key: "seeded",
        },
        {
          event_id: mode === "relocate-owner" ? "row-69" : "row-0",
          message_idempotency_key: "shared",
        },
      ]);
    });
  },
);

it("rejects a scalar duplicate without an identity read or advancing transcript order", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, events } = createSessionCompoundWorkerFixture();
    const first = { ...message("first", null, 1), message: { role: "user", content: "first" } };
    const next = { ...message("next", "first", 3), message: { role: "user", content: "next" } };
    const reads = trackSqliteStatementExecutions(database.db, ["identities"], (sql) =>
      /^select /i.test(sql) && sql.includes('from "transcript_event_identities"')
        ? "identities"
        : null,
    );
    try {
      runOpenClawAgentWriteTransaction(
        () => {
          expect(appendTranscriptEventInTransaction(database, scope, first)).toBe(
            JSON.stringify(first),
          );
          expect(
            appendTranscriptEventInTransaction(database, scope, {
              ...first,
              timestamp: 2,
              message: { role: "user", content: "rejected replacement" },
            }),
          ).toBe(false);
          expect(appendTranscriptEventInTransaction(database, scope, next)).toBe(
            JSON.stringify(next),
          );
        },
        { agentId: "main", path: database.path },
      );
      expect(reads.counts).toEqual({ identities: 0 });
    } finally {
      reads.restore();
    }
    expect(events()).toEqual([first, next]);
    expect(
      database.db
        .prepare(
          "SELECT event_id, seq FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
        )
        .all(scope.sessionId),
    ).toEqual([
      { event_id: "first", seq: 0 },
      { event_id: "next", seq: 1 },
    ]);
    expect(
      database.db
        .prepare(
          "SELECT active_event_count, active_message_count, indexed_seq, leaf_event_id FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({
      active_event_count: 2,
      active_message_count: 2,
      indexed_seq: 1,
      leaf_event_id: "next",
    });
  });
});

it("settles batch recency and index once, including rejected attempts and a later rewrite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, events } = createSessionCompoundWorkerFixture();
    const write = (run: () => void) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path });
    const append = (rows: ReturnType<typeof message>[]) =>
      appendTranscriptEventsInTransaction(database, scope, rows, { idempotencyKeyMode: "dedupe" });
    const window = () =>
      database.db
        .prepare(
          "SELECT updated_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
        )
        .get(scope.sessionId);
    const index = () =>
      database.db
        .prepare(
          "SELECT active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId);
    const generation = () =>
      database.db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get(scope.sessionId)?.generation;
    vi.spyOn(Date, "now").mockReturnValue(1000);
    write(() => expect(append([message("root", null, 10)])).toBe(1));
    const originalGeneration = generation();
    const writes = trackSqliteStatementExecutions(database.db, ["window", "index"], (sql) => {
      if (/^update "session_windows"/i.test(sql)) {
        return "window";
      }
      return /^(?:insert into|update) "session_transcript_index_state"/i.test(sql) ? "index" : null;
    });
    try {
      write(() =>
        expect(
          append([
            message("one", "root", 20),
            message("two", "one", 30),
            message("two", "one", 25),
            {
              ...message("rejected", "two", 40),
              message: { role: "user", content: "retry", idempotencyKey: "one" },
            },
          ]),
        ).toBe(2),
      );
      expect(writes.counts).toEqual({ window: 1, index: 1 });
    } finally {
      writes.restore();
    }
    expect(events().map((event) => event.id)).toEqual(["root", "one", "two"]);
    expect(window()).toEqual({ updated_at: 40, transcript_updated_at: 1001 });
    expect(index()).toEqual({
      active_event_count: 3,
      active_message_count: 3,
      indexed_seq: 2,
      leaf_event_id: "two",
      needs_rebuild: 0,
    });
    expect(generation()).toBe(originalGeneration);
    write(() => expect(append([message("two", "one", 50)])).toBe(0));
    expect(window()).toEqual({ updated_at: 50, transcript_updated_at: 1001 });
    write(() =>
      replaceSqliteTranscriptEventsInTransaction(database, scope, [message("reset", null, 60)]),
    );
    const rewrittenGeneration = generation();
    expect(rewrittenGeneration).not.toBe(originalGeneration);
    write(() => expect(append([message("after", "reset", 70)])).toBe(1));
    expect(generation()).toBe(rewrittenGeneration);
    expect(index()).toEqual({
      active_event_count: 2,
      active_message_count: 2,
      indexed_seq: 1,
      leaf_event_id: "after",
      needs_rebuild: 0,
    });
  });
});

it.each(["commit prefix", "rollback"] as const)(
  "settles a throwing iterator before %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope, events } = createSessionCompoundWorkerFixture();
      const write = (run: () => void) =>
        runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path });
      vi.spyOn(Date, "now").mockReturnValue(1000);
      write(() => {
        appendTranscriptEventsInTransaction(database, scope, [message("root", null, 10)]);
      });
      const feedback: boolean[] = [];
      function* rows(): Generator<ReturnType<typeof message>, void, boolean> {
        feedback.push(yield message("one", "root", 20));
        feedback.push(yield message("one", "root", 30));
        feedback.push(yield message("two", "one", 40));
        throw new Error("source failed");
      }
      const append = () => appendTranscriptEventsInTransaction(database, scope, rows());
      if (outcome === "rollback") {
        expect(() => write(append)).toThrow("source failed");
      } else {
        write(() => expect(append).toThrow("source failed"));
      }
      expect(feedback).toEqual([true, false, true]);
      const retained = outcome === "commit prefix";
      expect(events().map((event) => event.id)).toEqual(
        retained ? ["root", "one", "two"] : ["root"],
      );
      expect(
        database.db
          .prepare(
            "SELECT message_id FROM session_transcript_fts WHERE session_id = ? AND session_transcript_fts MATCH 'root OR one OR two' ORDER BY rowid",
          )
          .all(scope.sessionId),
      ).toEqual(
        (retained ? ["root", "one", "two"] : ["root"]).map((message_id) => ({ message_id })),
      );
      expect(
        database.db
          .prepare(
            "SELECT updated_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toEqual({ updated_at: retained ? 40 : 10, transcript_updated_at: 1000 });
      expect(
        database.db
          .prepare(
            "SELECT indexed_seq, leaf_event_id, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toEqual({
        indexed_seq: retained ? 2 : 0,
        leaf_event_id: retained ? "two" : "root",
        active_message_count: retained ? 3 : 1,
      });
    });
  },
);
