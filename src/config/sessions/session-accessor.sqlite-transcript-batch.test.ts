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
import { timedMessageEvent } from "./transcript-message.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function message(id: string, parentId: string | null, timestamp: number) {
  return timedMessageEvent(id, parentId, timestamp, {
    role: "user",
    content: id,
    idempotencyKey: id,
  });
}

function indexState(count: number, leaf: string) {
  return {
    active_event_count: count,
    active_message_count: count,
    indexed_seq: count - 1,
    leaf_event_id: leaf,
  };
}

function fixture() {
  const original = createSessionCompoundWorkerFixture();
  const { database, scope } = original;
  const get = (table: string, columns: string) =>
    database.db
      .prepare(`SELECT ${columns} FROM ${table} WHERE session_id = ?`)
      .get(scope.sessionId);
  return {
    ...original,
    write: (run: () => void) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path }),
    append: (
      rows: Parameters<typeof appendTranscriptEventsInTransaction>[2],
      options?: Parameters<typeof appendTranscriptEventsInTransaction>[3],
      target = scope,
    ) => appendTranscriptEventsInTransaction(database, target, rows, options),
    single: (event: Parameters<typeof appendTranscriptEventInTransaction>[2]) =>
      appendTranscriptEventInTransaction(database, scope, event),
    all: (sql: string) => database.db.prepare(sql).all(scope.sessionId),
    window: () => get("session_windows", "updated_at, transcript_updated_at"),
    index: () =>
      get(
        "session_transcript_index_state",
        "active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild",
      ),
    generation: () => get("transcript_rewrite_watermarks", "generation")?.generation,
    identities: (sessionId = scope.sessionId) =>
      database.db
        .prepare(
          "SELECT event_id, seq FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
        )
        .all(sessionId),
  };
}

function withFixture(run: (context: ReturnType<typeof fixture>) => void) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => run(fixture()));
}

function withCounts<T>(counter: { counts: T; restore: () => void }, run: () => void) {
  try {
    run();
    return counter.counts;
  } finally {
    counter.restore();
  }
}

it("creates a new transcript root and keeps its ownership and sequence on later batches", () =>
  withFixture(({ database, scope, write, append, identities }) => {
    const fresh = { ...scope, sessionId: "fresh", sessionKey: "agent:main:fresh" };
    write(() => expect(append([message("first", null, 1)], undefined, fresh)).toBe(1));
    expect(
      database.db
        .prepare(
          "SELECT node.current_session_id, window.session_key, watermark.generation FROM session_nodes AS node JOIN session_windows AS window ON window.session_id = node.current_session_id JOIN transcript_rewrite_watermarks AS watermark ON watermark.session_id = window.session_id WHERE node.session_key = ?",
        )
        .get(fresh.sessionKey),
    ).toEqual({
      current_session_id: fresh.sessionId,
      session_key: fresh.sessionKey,
      generation: expect.any(String),
    });
    write(() => expect(append([message("next", "first", 2)], undefined, fresh)).toBe(1));
    expect(() =>
      write(() => {
        append([message("wrong", "next", 3)], undefined, {
          ...fresh,
          sessionKey: "agent:main:wrong",
        });
      }),
    ).toThrow("is owned by agent:main:fresh");
    expect(identities(fresh.sessionId)).toEqual([
      { event_id: "first", seq: 0 },
      { event_id: "next", seq: 1 },
    ]);
  }));

it("batches bounded inserts while preserving order and subsequent identity rejection", () =>
  withFixture(({ database, events, write, append, single, all, identities }) => {
    const rows = Array.from({ length: 1030 }, (_, index) =>
      message(`row-${index}`, index === 0 ? null : `row-${index - 1}`, index + 1),
    );
    const buckets = [
      [
        "classificationReads",
        (sql: string) =>
          /^select /i.test(sql) &&
          sql.includes('from "session_transcript_active_events"') &&
          !sql.includes('from "session_transcript_index_state"'),
      ],
      ["ftsIdentities", (sql: string) => /^insert into "session_transcript_fts_rows"/i.test(sql)],
      ["ftsContent", (sql: string) => sql.includes('insert into "session_transcript_fts"')],
      ["identities", (sql: string) => /^insert into "transcript_event_identities"/i.test(sql)],
      ["payloads", (sql: string) => /^insert into "transcript_events"/i.test(sql)],
      ["active", (sql: string) => /^insert into "session_transcript_active_events"/i.test(sql)],
      [
        "identityReads",
        (sql: string) =>
          /^select /i.test(sql) && sql.includes('from "transcript_event_identities"'),
      ],
    ] as const;
    const writes = trackSqliteStatementExecutions(
      database.db,
      buckets.map(([key]) => key),
      (sql) => buckets.find(([, matches]) => matches(sql))?.[0] ?? null,
    );
    expect(withCounts(writes, () => write(() => expect(append(rows)).toBe(1030)))).toEqual({
      identities: 3,
      payloads: 3,
      active: 3,
      identityReads: 1,
      ftsIdentities: 3,
      ftsContent: 3,
      classificationReads: 0,
    });
    write(() => {
      expect(single(rows[512]!)).toBe(false);
      expect(append([rows[1029]!, message("tail", "row-1029", 2000)])).toBe(1);
    });
    expect(events().map((event) => event.id)).toEqual([...rows.map((row) => row.id), "tail"]);
    expect(
      all(
        "SELECT message_id FROM session_transcript_fts WHERE session_id = ? AND session_transcript_fts MATCH 'row OR tail' ORDER BY rowid",
      ),
    ).toEqual([...rows.map((row) => row.id), "tail"].map((message_id) => ({ message_id })));
    expect(identities()).toEqual(
      [...rows, { id: "tail" }].map((row, seq) => ({ event_id: row.id, seq })),
    );
  }));

it.each(
  (["dedupe", "preserve-owner", "relocate-owner"] as const).flatMap((mode) =>
    (["prepared-array", "streaming"] as const).map((source) => ({ mode, source })),
  ),
)(
  "preserves $mode key ownership within buffered rows and across flushes for $source",
  ({ mode, source }) =>
    withFixture(({ database, scope, events, write, append, single }) => {
      const seed = message("seed", null, 1);
      seed.message.idempotencyKey = "seeded";
      write(() => single(seed));
      const rows = Array.from({ length: 520 }, (_, index) =>
        message(`row-${index}`, null, index + 2),
      );
      for (const index of [0, 1, 519]) {
        rows[index]!.message.idempotencyKey = "shared";
      }
      for (const index of [2, 518]) {
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
          append(source === "prepared-array" ? rows : streamRows(), { idempotencyKeyMode: mode }),
        ).toBe(mode === "dedupe" ? 516 : 520);
      });
      const expectedAccepted = rows.map(
        (_, index) => mode !== "dedupe" || ![1, 2, 518, 519].includes(index),
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
      ).toEqual(
        [
          ["seeded", mode === "relocate-owner" ? "row-518" : "seed"],
          ["shared", mode === "relocate-owner" ? "row-519" : "row-0"],
        ].map(([message_idempotency_key, event_id]) => ({ event_id, message_idempotency_key })),
      );
    }),
);

it("rejects a scalar duplicate without an identity read or advancing transcript order", () =>
  withFixture(({ database, events, write, single, index, identities }) => {
    const first = { ...message("first", null, 1), message: { role: "user", content: "first" } };
    const next = { ...message("next", "first", 3), message: { role: "user", content: "next" } };
    const reads = trackSqliteStatementExecutions(database.db, ["identities"], (sql) =>
      /^select /i.test(sql) && sql.includes('from "transcript_event_identities"')
        ? "identities"
        : null,
    );
    expect(
      withCounts(reads, () =>
        write(() => {
          expect(single(first)).toBe(JSON.stringify(first));
          expect(
            single({
              ...first,
              timestamp: 2,
              message: { role: "user", content: "rejected replacement" },
            }),
          ).toBe(false);
          expect(single(next)).toBe(JSON.stringify(next));
        }),
      ),
    ).toEqual({ identities: 0 });
    expect(events()).toEqual([first, next]);
    expect(identities()).toEqual([
      { event_id: "first", seq: 0 },
      { event_id: "next", seq: 1 },
    ]);
    expect(index()).toMatchObject(indexState(2, "next"));
  }));

it("settles batch recency and index once, including rejected attempts and a later rewrite", () =>
  withFixture(
    ({ database, scope, events, write, window, index, generation, append: appendBatch }) => {
      const append = (rows: ReturnType<typeof message>[]) =>
        appendBatch(rows, { idempotencyKeyMode: "dedupe" });
      vi.spyOn(Date, "now").mockReturnValue(1000);
      write(() => expect(append([message("root", null, 10)])).toBe(1));
      const originalGeneration = generation();
      const writes = trackSqliteStatementExecutions(
        database.db,
        ["window", "index", "reads", "ensures"],
        (sql) => {
          if (/^select /i.test(sql)) {
            return "reads";
          }
          if (/^insert into "(?:session_windows|transcript_rewrite_watermarks)"/i.test(sql)) {
            return "ensures";
          }
          if (/^update "session_windows"/i.test(sql)) {
            return "window";
          }
          return /^(?:insert into|update) "session_transcript_index_state"/i.test(sql)
            ? "index"
            : null;
        },
      );
      expect(
        withCounts(writes, () =>
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
          ),
        ),
      ).toEqual({ window: 1, index: 1, reads: 2, ensures: 0 });
      expect(events().map((event) => event.id)).toEqual(["root", "one", "two"]);
      expect(window()).toEqual({ updated_at: 40, transcript_updated_at: 1001 });
      expect(index()).toEqual({ ...indexState(3, "two"), needs_rebuild: 0 });
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
      expect(index()).toEqual({ ...indexState(2, "after"), needs_rebuild: 0 });
    },
  ));

it.each(["commit prefix", "rollback"] as const)(
  "settles a throwing iterator before %s",
  (outcome) =>
    withFixture(({ events, write, append: appendBatch, all, window, index }) => {
      vi.spyOn(Date, "now").mockReturnValue(1000);
      write(() => appendBatch([message("root", null, 10)]));
      const feedback: boolean[] = [];
      function* rows(): Generator<ReturnType<typeof message>, void, boolean> {
        feedback.push(yield message("one", "root", 20));
        feedback.push(yield message("one", "root", 30));
        feedback.push(yield message("two", "one", 40));
        throw new Error("source failed");
      }
      const append = () => appendBatch(rows());
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
        all(
          "SELECT message_id FROM session_transcript_fts WHERE session_id = ? AND session_transcript_fts MATCH 'root OR one OR two' ORDER BY rowid",
        ),
      ).toEqual(
        (retained ? ["root", "one", "two"] : ["root"]).map((message_id) => ({ message_id })),
      );
      expect(window()).toEqual({ updated_at: retained ? 40 : 10, transcript_updated_at: 1000 });
      expect(index()).toMatchObject({
        indexed_seq: retained ? 2 : 0,
        leaf_event_id: retained ? "two" : "root",
        active_message_count: retained ? 3 : 1,
      });
    }),
);
