import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSessionTranscriptFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction,
  selectSessionTranscriptFtsRows,
} from "./session-transcript-fts.js";
import {
  createTranscriptIndexAppenderInTransaction,
  deleteSessionTranscriptIndexInTransaction,
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
  replaceSessionTranscriptIndexSuffixInTransaction,
} from "./session-transcript-index.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("transcript-fts-") },
  };
  return { options, database: openOpenClawAgentDatabase(options) };
}

it("preserves duplicate message identities and nullable cold rows through indexed deletion and rollback", () => {
  const { options, database } = fixture();
  runOpenClawAgentWriteTransaction(({ db }) => {
    const insert = createSessionTranscriptFtsInserter(db, "session");
    insert({ messageId: "duplicate", text: "first searchable", role: "user", timestamp: 10 });
    insert({
      messageId: "duplicate",
      text: "second searchable",
      role: "assistant",
      timestamp: "10",
    });
    insert({ messageId: null, text: null, role: null, timestamp: null });
    createSessionTranscriptFtsInserter(
      db,
      "other",
    )({
      messageId: "duplicate",
      text: "unrelated searchable",
      role: "user",
      timestamp: 11,
    });
  }, options);
  const read = () =>
    executeSqliteQuerySync(database.db, selectSessionTranscriptFtsRows(database.db, "session"))
      .rows;
  const before = read();
  expect(before).toEqual([
    { message_id: "duplicate", text: "first searchable", role: "user", timestamp: 10 },
    { message_id: "duplicate", text: "second searchable", role: "assistant", timestamp: "10" },
    { message_id: null, text: null, role: null, timestamp: null },
  ]);

  expect(() =>
    runOpenClawAgentWriteTransaction(({ db }) => {
      // Exercise the schema-owned delete independently of the runtime delete helper.
      db.exec(`DELETE FROM session_transcript_fts_rows
        WHERE id = (SELECT MIN(id) FROM session_transcript_fts_rows WHERE session_id = 'session')`);
      expect(read()).toEqual(before.slice(1));
      expect(
        db
          .prepare(
            "SELECT text FROM session_transcript_fts WHERE session_transcript_fts MATCH 'first'",
          )
          .all(),
      ).toEqual([]);
      throw new Error("roll back both projections");
    }, options),
  ).toThrow("roll back both projections");
  expect(read()).toEqual(before);

  runOpenClawAgentWriteTransaction(({ db }) => {
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: [] })).toBe(0);
    expect(
      deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: ["duplicate"] }),
    ).toBe(2);
    expect(read()).toEqual([before[2]]);
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { maxRows: 1 })).toBe(1);
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { maxRows: 1 })).toBe(0);
  }, options);
  expect(database.db.prepare("SELECT session_id, text FROM session_transcript_fts").all()).toEqual([
    { session_id: "other", text: "unrelated searchable" },
  ]);
});

it("allocates FTS identities beyond the JavaScript safe-integer boundary without rounding", () => {
  const { options, database } = fixture();
  runOpenClawAgentWriteTransaction(({ db }) => {
    db.exec(`
      INSERT INTO session_transcript_fts_rows(id, session_id, message_id)
        VALUES (9007199254740992, 'session', 'retained');
      INSERT INTO session_transcript_fts(rowid, session_id, message_id, text, role, timestamp)
        VALUES (9007199254740992, 'session', 'retained', 'old searchable', 'user', 1);
    `);
    createSessionTranscriptFtsInserter(
      db,
      "session",
    )({
      messageId: "appended",
      text: "new searchable",
      role: "assistant",
      timestamp: 1,
    });
  }, options);
  expect(
    database.db
      .prepare(`SELECT CAST(rowid AS TEXT) AS id, message_id
      FROM session_transcript_fts ORDER BY rowid`)
      .all(),
  ).toEqual([
    { id: "9007199254740992", message_id: "retained" },
    { id: "9007199254740993", message_id: "appended" },
  ]);
  runOpenClawAgentWriteTransaction(({ db }) => {
    expect(
      deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: ["appended"] }),
    ).toBe(1);
  }, options);
  expect(database.db.prepare("SELECT message_id FROM session_transcript_fts").all()).toEqual([
    { message_id: "retained" },
  ]);
});

function projectionFixture(interleaved = true) {
  const db = openNodeSqliteDatabase(":memory:");
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.exec("BEGIN");
  for (const id of ["target", "sibling"]) {
    db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)",
    ).run(id, id);
    db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run(id, id);
  }
  const appenders = new Map(
    ["target", "sibling"].map((id) => [id, createTranscriptIndexAppenderInTransaction(db, id)]),
  );
  for (let i = 0; i < 8; i++) {
    const id = (interleaved ? i % 2 : Math.floor(i / 4)) ? "sibling" : "target";
    const seq = interleaved ? Math.floor(i / 2) : i % 4;
    const eventId = `${id}-${seq}`;
    const event = {
      type: "message",
      id: eventId,
      parentId: seq ? `${id}-${seq - 1}` : null,
      message: { role: "user", content: `needle ${eventId}` },
    };
    db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, seq, JSON.stringify(event), seq);
    expect(appenders.get(id)!({ seq, event, eventId, createdAt: seq })).toBe(false);
  }
  db.exec("COMMIT");
  return db;
}

function hits(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT session_id, message_id, text FROM session_transcript_fts WHERE session_transcript_fts MATCH 'needle' ORDER BY session_id, message_id",
    )
    .all();
}

function expectMapped(db: DatabaseSync, count: number) {
  expect(db.prepare("SELECT count(*) n FROM session_transcript_fts_rows").get()?.n).toBe(count);
  expect(
    db
      .prepare(`SELECT count(*) n FROM session_transcript_fts_rows m
    LEFT JOIN session_transcript_fts f ON f.rowid=m.id
    WHERE f.rowid IS NULL OR f.session_id != m.session_id`)
      .get()?.n,
  ).toBe(0);
}

function captureDeletePlans(db: DatabaseSync) {
  const prepare = db.prepare.bind(db);
  const plans: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    if (query.startsWith('delete from "session_transcript_fts_rows"')) {
      const placeholders = query.match(/\?/g)?.length ?? 0;
      plans.push(
        ...prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...Array.from({ length: placeholders }, () => "target"))
          .map((row) => String(row.detail)),
      );
    }
    return prepare(query);
  });
  return { plans, restore: () => spy.mockRestore() };
}

describe("exact session transcript FTS ownership", () => {
  it("replaces a suffix larger than SQLite's parameter limit without touching siblings", () => {
    const db = projectionFixture();
    try {
      const siblings = hits(db).filter((row) => row.session_id === "sibling");
      const variableLimit = db
        .prepare("PRAGMA compile_options")
        .all()
        .map((row) => String(row.compile_options))
        .find((option) => option.startsWith("MAX_VARIABLE_NUMBER="));
      const bulkRows = Number(variableLimit?.split("=")[1] ?? 32766) + 1;
      const totalRows = bulkRows + 4;
      db.exec(`BEGIN;
        WITH RECURSIVE rows(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM rows WHERE n<${bulkRows - 1})
        INSERT INTO transcript_events (session_id, seq, event_json, created_at) SELECT 'target', n+4,
          json_object('type','message','id','bulk-'||n,
            'parentId',CASE WHEN n=0 THEN 'target-3' ELSE 'bulk-'||(n-1) END,
            'message',json_object('role','user','content','needle bulk-'||n)), n+4 FROM rows;
        INSERT INTO session_transcript_active_events
          SELECT session_id,seq,seq,seq,1 FROM transcript_events WHERE session_id='target' AND seq>=4;
        INSERT INTO session_transcript_fts(text,session_id,message_id,role,timestamp)
          SELECT 'needle bulk-'||(seq-4),session_id,'bulk-'||(seq-4),'user',seq
          FROM transcript_events WHERE session_id='target' AND seq>=4;
        INSERT INTO session_transcript_fts_rows (id,session_id,message_id)
          SELECT rowid,session_id,message_id FROM session_transcript_fts WHERE session_id='target'
          AND message_id LIKE 'bulk-%';
        UPDATE session_transcript_index_state SET active_event_count=${totalRows},
          active_message_count=${totalRows}, indexed_seq=${totalRows - 1}, leaf_event_id='bulk-${bulkRows - 1}'
          WHERE session_id='target';`);
      const removedMessageIds = [
        ...Array.from({ length: 4 }, (_, i) => `target-${i}`),
        ...Array.from({ length: bulkRows }, (_, i) => `bulk-${i}`),
      ];
      db.prepare("DELETE FROM transcript_events WHERE session_id='target'").run();
      replaceSessionTranscriptIndexSuffixInTransaction(db, "target", {
        unchangedBeforeSeq: 0,
        retainedActiveCount: 0,
        removedMessageIds,
        next: { activeRows: [], activeMessageCount: 0, indexedSeq: -1, leafEventId: null },
      });
      db.exec("COMMIT");
      expect(hits(db)).toEqual(siblings);
      expectMapped(db, 4);
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "reconciles by point lookup and preserves interleaved siblings (%s)",
    (interleaved) => {
      const db = projectionFixture(interleaved);
      try {
        const expected = hits(db);
        const capture = captureDeletePlans(db);
        db.exec("BEGIN");
        markSessionTranscriptIndexDirtyInTransaction(db, "target");
        expect(reconcileSessionTranscriptIndexInTransaction(db, "target")).toBe(true);
        db.exec("COMMIT");
        capture.restore();
        expect(
          capture.plans.filter((plan) =>
            plan.includes("idx_session_transcript_fts_rows_session_message"),
          ),
        ).toEqual([expect.stringContaining("idx_session_transcript_fts_rows_session_message")]);
        expect(hits(db)).toEqual(expected);
        expectMapped(db, 8);
        db.exec("BEGIN");
        deleteSessionTranscriptIndexInTransaction(db, "target");
        db.exec("COMMIT");
        expect(hits(db)).toEqual(expected.filter((row) => row.session_id === "sibling"));
        expectMapped(db, 4);
      } finally {
        db.close();
      }
    },
  );

  it.each([false, true])(
    "keeps worker chunks and interrupted rebuilds mapped (missing content: %s)",
    (missingContent) => {
      const db = projectionFixture();
      try {
        const expected = hits(db);
        if (missingContent) {
          db.prepare("DELETE FROM session_transcript_fts WHERE message_id='target-1'").run();
        }
        markSessionTranscriptIndexDirtyInTransaction(db, "target");
        const plan = prepareSessionTranscriptProjection(db, "target")!;
        for (const claimId of [-1, -2]) {
          db.exec("BEGIN");
          expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, claimId)).toBe(
            true,
          );
          db.exec("COMMIT");
          let more = true;
          while (more) {
            db.exec("BEGIN");
            const result = deletePreparedSessionTranscriptProjectionChunkInTransaction(db, {
              sessionId: "target",
              claimId,
              maxRowsPerTable: 2,
            });
            more = result.hasMore;
            expect(result.owned).toBe(true);
            db.exec("COMMIT");
            expectMapped(
              db,
              Number(db.prepare("SELECT count(*) n FROM session_transcript_fts").get()?.n),
            );
          }
          db.exec("BEGIN");
          expect(
            appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
              sessionId: "target",
              claimId,
              activeRows: claimId === -1 ? [] : plan.activeRows,
              ftsRows: claimId === -1 ? plan.ftsRows.slice(0, 1) : plan.ftsRows,
            }),
          ).toBe(true);
          if (claimId === -2) {
            expect(
              finalizePreparedSessionTranscriptProjectionInTransaction(db, plan, claimId),
            ).toBe(true);
          }
          db.exec("COMMIT");
        }
        expectMapped(db, 8);
        expect(hits(db)).toEqual(expected);
      } finally {
        db.close();
      }
    },
  );
});
