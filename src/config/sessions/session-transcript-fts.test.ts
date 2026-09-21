import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
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

function fixture(interleaved = true) {
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
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(
      id,
      seq,
      JSON.stringify(event),
      seq,
    );
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
    LEFT JOIN session_transcript_fts f ON f.rowid=m.fts_rowid
    WHERE f.rowid IS NULL OR f.session_id != m.session_id`)
      .get()?.n,
  ).toBe(0);
  expect(
    db
      .prepare(`SELECT session_id FROM session_transcript_index_state s
    WHERE fts_row_count IS NULL OR fts_row_count !=
      (SELECT count(*) FROM session_transcript_fts_rows m WHERE m.session_id=s.session_id)`)
      .all(),
  ).toEqual([]);
}

function captureDeletePlans(db: DatabaseSync) {
  const prepare = db.prepare.bind(db);
  const plans: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    if (query.startsWith('delete from "session_transcript_fts"')) {
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
    const db = fixture();
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
        INSERT INTO transcript_events SELECT 'target', n+4,
          json_object('type','message','id','bulk-'||n,
            'parentId',CASE WHEN n=0 THEN 'target-3' ELSE 'bulk-'||(n-1) END,
            'message',json_object('role','user','content','needle bulk-'||n)), n+4 FROM rows;
        INSERT INTO session_transcript_active_events
          SELECT session_id,seq,seq,seq,1 FROM transcript_events WHERE session_id='target' AND seq>=4;
        INSERT INTO session_transcript_fts(text,session_id,message_id,role,timestamp)
          SELECT 'needle bulk-'||(seq-4),session_id,'bulk-'||(seq-4),'user',seq
          FROM transcript_events WHERE session_id='target' AND seq>=4;
        INSERT INTO session_transcript_fts_rows
          SELECT session_id,rowid FROM session_transcript_fts WHERE session_id='target'
          AND message_id LIKE 'bulk-%';
        UPDATE session_transcript_index_state SET fts_row_count=${totalRows}, active_event_count=${totalRows},
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
      const db = fixture(interleaved);
      try {
        const expected = hits(db);
        const capture = captureDeletePlans(db);
        db.exec("BEGIN");
        markSessionTranscriptIndexDirtyInTransaction(db, "target");
        expect(reconcileSessionTranscriptIndexInTransaction(db, "target")).toBe(true);
        db.exec("COMMIT");
        capture.restore();
        expect(capture.plans.filter((plan) => plan.includes("VIRTUAL TABLE INDEX"))).toEqual([
          expect.stringMatching(/VIRTUAL TABLE INDEX .*:=/),
        ]);
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

  it.each(["legacy", "missing", "incomplete"])(
    "heals %s ownership once without duplicating an older writer's later row",
    (kind) => {
      const db = fixture();
      try {
        const expected = hits(db);
        db.exec("BEGIN");
        db.exec(
          kind === "incomplete"
            ? "DELETE FROM session_transcript_fts_rows WHERE fts_rowid=(SELECT max(fts_rowid) FROM session_transcript_fts_rows WHERE session_id='target')"
            : "DELETE FROM session_transcript_fts_rows WHERE session_id='target'",
        );
        if (kind === "legacy") {
          db.exec(
            "UPDATE session_transcript_index_state SET fts_row_count=NULL WHERE session_id='target'",
          );
        }
        expect(reconcileSessionTranscriptIndexInTransaction(db, "target")).toBe(true);
        db.exec("COMMIT");
        expect(hits(db)).toEqual(expected);
        expectMapped(db, 8);
        const capture = captureDeletePlans(db);
        db.exec("BEGIN");
        markSessionTranscriptIndexDirtyInTransaction(db, "target");
        reconcileSessionTranscriptIndexInTransaction(db, "target");
        db.exec("COMMIT");
        capture.restore();
        expect(capture.plans.filter((plan) => plan.includes("VIRTUAL TABLE INDEX"))).toEqual([
          expect.stringMatching(/VIRTUAL TABLE INDEX .*:=/),
        ]);
        expect(hits(db)).toEqual(expected);
      } finally {
        db.close();
      }
    },
  );

  it.each([false, true])(
    "keeps worker chunks and interrupted rebuilds mapped (missing content: %s)",
    (missingContent) => {
      const db = fixture();
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
