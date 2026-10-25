import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSessionTranscriptFtsInserter as createFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction as deleteFtsRows,
  selectSessionTranscriptFtsRows as selectFtsRows,
} from "./session-transcript-fts.js";
import {
  createTranscriptIndexAppenderInTransaction as createIndexAppender,
  deleteSessionTranscriptIndexInTransaction as deleteIndex,
  markSessionTranscriptIndexDirtyInTransaction as markIndexDirty,
  reconcileSessionTranscriptIndexInTransaction as reconcileIndex,
  replaceSessionTranscriptIndexSuffixInTransaction as replaceIndexSuffix,
} from "./session-transcript-index.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction as appendProjectionChunk,
  claimPreparedSessionTranscriptProjectionInTransaction as claimProjection,
  deletePreparedSessionTranscriptProjectionChunkInTransaction as deleteProjectionChunk,
  finalizePreparedSessionTranscriptProjectionInTransaction as finalizeProjection,
  prepareSessionTranscriptProjection as prepareProjection,
} from "./session-transcript-projection-rebuild.js";
import { messageEvent } from "./transcript-message.test-support.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";
import { deriveTranscriptPredicateFields } from "./transcript-predicate-fields.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const projectionDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of projectionDatabases.splice(0)) {
    db.close();
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function rows(db: EngineConnection, sql: string) {
  return db.prepare(sql).all();
}

function fixture() {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("transcript-fts-") },
  };
  return { options, database: openOpenClawAgentDatabase(options) };
}

it("preserves exact 64-bit identities, duplicates and cold rows through deletion and rollback", () => {
  const { options, database } = fixture();
  const expectedRows = [
    { message_id: "duplicate", text: "first searchable", role: "user", timestamp: 10 },
    { message_id: "duplicate", text: "second searchable", role: "assistant", timestamp: "10" },
    { message_id: null, text: null, role: null, timestamp: null },
  ];
  writeTransaction(({ db }) => {
    db.exec(`
      INSERT INTO session_transcript_fts_rows(id, session_id, message_id)
        VALUES (9007199254740992, 'other', 'duplicate');
      INSERT INTO session_transcript_fts(rowid, session_id, message_id, text, role, timestamp)
        VALUES (9007199254740992, 'other', 'duplicate', 'unrelated searchable', 'user', 11);
    `);
    createFtsInserter(
      db,
      "session",
    )(expectedRows.map(({ message_id, ...row }) => ({ ...row, messageId: message_id })));
  }, options);
  expect(
    rows(
      database.db,
      "SELECT CAST(rowid AS TEXT) AS id, session_id, message_id FROM session_transcript_fts ORDER BY rowid",
    ),
  ).toEqual([
    { id: "9007199254740992", session_id: "other", message_id: "duplicate" },
    { id: "9007199254740993", session_id: "session", message_id: "duplicate" },
    { id: "9007199254740994", session_id: "session", message_id: "duplicate" },
    { id: "9007199254740995", session_id: "session", message_id: null },
  ]);
  const read = () =>
    executeSqliteQuerySync(database.db, selectFtsRows(database.db, "session")).rows;
  const before = read();
  expect(before).toEqual(expectedRows);

  expect(() =>
    writeTransaction(({ db }) => {
      // Exercise the schema-owned delete independently of the runtime delete helper.
      db.exec(`DELETE FROM session_transcript_fts_rows
        WHERE id = (SELECT MIN(id) FROM session_transcript_fts_rows WHERE session_id = 'session')`);
      expect(read()).toEqual(before.slice(1));
      expect(
        rows(
          db,
          "SELECT text FROM session_transcript_fts WHERE session_transcript_fts MATCH 'first'",
        ),
      ).toEqual([]);
      throw new Error("roll back both projections");
    }, options),
  ).toThrow("roll back both projections");
  expect(read()).toEqual(before);

  writeTransaction(({ db }) => {
    expect(deleteFtsRows(db, "session", { messageIds: [] })).toBe(0);
    expect(deleteFtsRows(db, "session", { messageIds: ["duplicate"] })).toBe(2);
    expect(read()).toEqual([before[2]]);
    expect(deleteFtsRows(db, "session", { maxRows: 1 })).toBe(1);
    expect(deleteFtsRows(db, "session", { maxRows: 1 })).toBe(0);
  }, options);
  expect(database.db.prepare("SELECT session_id, text FROM session_transcript_fts").all()).toEqual([
    { session_id: "other", text: "unrelated searchable" },
  ]);
});

function projectionFixture(seed = true) {
  const db = openNodeSqliteDatabase(":memory:");
  projectionDatabases.push(db);
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  admitSqliteSchema(db);
  db.exec("BEGIN");
  for (const id of ["target", "sibling"]) {
    db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', 1)",
    ).run(id, id);
    db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    ).run(id, id);
  }
  const appenders = new Map(["target", "sibling"].map((id) => [id, createIndexAppender(db, id)]));
  const inserters = new Map(
    ["target", "sibling"].map((id) => [id, createTranscriptEventInserter(db, id)]),
  );
  for (let i = 0; i < (seed ? 8 : 0); i++) {
    const id = i % 2 ? "sibling" : "target";
    const seq = Math.floor(i / 2);
    const eventId = `${id}-${seq}`;
    const event = messageEvent(eventId, seq ? `${id}-${seq - 1}` : null, {
      role: "user",
      content: `needle ${eventId}`,
    });
    inserters.get(id)!({ seq, eventJson: JSON.stringify(event), createdAt: seq });
    expect(appenders.get(id)!.append({ seq, event, eventId, createdAt: seq })).toBe(false);
  }
  for (const appender of appenders.values()) {
    appender.flush();
  }
  db.exec("COMMIT");
  return db;
}

function hits(db: DatabaseSync) {
  return rows(
    db,
    "SELECT session_id, message_id, text FROM session_transcript_fts WHERE session_transcript_fts MATCH 'needle' ORDER BY session_id, message_id",
  );
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

it("replaces a suffix larger than SQLite's parameter limit without touching siblings", () => {
  const db = projectionFixture();
  const siblings = hits(db).filter((row) => row.session_id === "sibling");
  const variableLimit = rows(db, "PRAGMA compile_options")
    .map((row) => String(row.compile_options))
    .find((option) => option.startsWith("MAX_VARIABLE_NUMBER="));
  const bulkRows = Number(variableLimit?.split("=")[1] ?? 32766) + 1;
  const totalRows = bulkRows + 4;
  db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE rows(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM rows WHERE n<${bulkRows - 1})
        INSERT INTO transcript_events (session_id, seq, event_json, created_at,
          navigation_type, navigation_custom_type, navigation_display, message_role,
          navigation_last_type, navigation_last_custom_type, navigation_valid)
        SELECT 'target', n+4,
          json_object('type','message','id','bulk-'||n,
            'parentId',CASE WHEN n=0 THEN 'target-3' ELSE 'bulk-'||(n-1) END,
            'message',json_object('role','user','content','needle bulk-'||n)), n+4,
          $navigation_type, $navigation_custom_type, $navigation_display, $message_role,
          $navigation_last_type, $navigation_last_custom_type, $navigation_valid FROM rows`).run(
    deriveTranscriptPredicateFields('{"type":"message","message":{"role":"user"}}'),
  );
  db.exec(`
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
  replaceIndexSuffix(db, "target", {
    unchangedBeforeSeq: 0,
    retainedActiveCount: 0,
    removedMessageIds,
    next: { activeRows: [], activeMessageCount: 0, indexedSeq: -1, leafEventId: null },
  });
  db.exec("COMMIT");
  expect(hits(db)).toEqual(siblings);
  expectMapped(db, 4);
});

it("reconciles by point lookup and preserves interleaved siblings", () => {
  const db = projectionFixture();
  const expected = hits(db);
  const capture = captureDeletePlans(db);
  db.exec("BEGIN");
  markIndexDirty(db, "target");
  expect(reconcileIndex(db, "target")).toBe(true);
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
  deleteIndex(db, "target");
  db.exec("COMMIT");
  expect(hits(db)).toEqual(expected.filter((row) => row.session_id === "sibling"));
  expectMapped(db, 4);
});

it("keeps worker chunks and interrupted rebuilds mapped with missing content", () => {
  const db = projectionFixture();
  const expected = hits(db);
  db.prepare("DELETE FROM session_transcript_fts WHERE message_id='target-1'").run();
  markIndexDirty(db, "target");
  const plan = prepareProjection(db, "target")!;
  for (const claimId of [-1, -2]) {
    db.exec("BEGIN");
    expect(claimProjection(db, plan, claimId)).toBe(true);
    db.exec("COMMIT");
    let more = true;
    while (more) {
      db.exec("BEGIN");
      const result = deleteProjectionChunk(db, {
        sessionId: "target",
        maxRowsPerTable: 2,
      });
      more = result.hasMore;
      db.exec("COMMIT");
      expectMapped(
        db,
        Number(db.prepare("SELECT count(*) n FROM session_transcript_fts").get()?.n),
      );
    }
    db.exec("BEGIN");
    appendProjectionChunk(db, {
      sessionId: "target",
      activeRows: claimId === -1 ? [] : plan.activeRows,
      ftsRows: claimId === -1 ? plan.ftsRows.slice(0, 1) : plan.ftsRows,
    });
    if (claimId === -2) {
      expect(finalizeProjection(db, plan, claimId)).toBe(true);
    }
    db.exec("COMMIT");
  }
  expectMapped(db, 8);
  expect(hits(db)).toEqual(expected);
});

function message(
  id: string,
  parentId: string | null | undefined,
  role: string,
  content: unknown,
  timestamp?: string,
) {
  return {
    type: "message",
    id,
    ...(parentId !== undefined ? { parentId } : {}),
    message: { role, content },
    ...(timestamp ? { timestamp } : {}),
  };
}
const activeRows = (...seqs: number[]) =>
  seqs.map((eventSeq, activePosition) => ({
    activePosition,
    contextEligible: 1,
    eventSeq,
    messagePosition: activePosition,
  }));
const ftsRow = (messageId: string, role: string, text: string, timestamp: number) => ({
  messageId,
  role,
  text,
  timestamp,
});

it.each([
  {
    name: "one deterministic active branch",
    version: 3,
    events: [
      message("root", null, "user", "root text"),
      message("abandoned", "root", "assistant", "abandoned text"),
      message("active", "root", "assistant", "active text"),
    ],
    expected: {
      activeEventCount: 2,
      activeMessageCount: 2,
      leafEventId: "active",
      sessionId: "target",
      sourceIndexedSeq: 3,
      sourceTranscriptUpdatedAt: 42,
      activeRows: activeRows(1, 3),
      ftsRows: [
        ftsRow("root", "user", "root text", 1_000),
        ftsRow("active", "assistant", "active text", 3_000),
      ],
    },
  },
  {
    name: "persisted timestamps for missing and invalid message timestamps",
    version: 3,
    events: [
      message("old-user", null, "user", [{ text: "old content", type: "text" }]),
      message("invalid-timestamp", "old-user", "assistant", "still old", "not a date"),
    ],
    createdAt: [1_700_000_000_000, 1_700_000_001_000],
    expected: {
      ftsRows: [
        ftsRow("old-user", "user", "old content", 1_700_000_000_000),
        ftsRow("invalid-timestamp", "assistant", "still old", 1_700_000_001_000),
      ],
    },
  },
  {
    name: "malformed content blocks do not drop neighboring text",
    version: 3,
    events: [
      message("mixed-content", null, "assistant", [
        { text: "ignored", type: { toString: null } },
        { text: "kept", type: "text" },
      ]),
    ],
    expected: { ftsRows: [ftsRow("mixed-content", "assistant", "kept", 1_000)] },
  },
  {
    name: "leaf-control rewind excludes the abandoned continuation",
    version: 3,
    events: [
      message("root", null, "user", "keep"),
      message("abandoned", "root", "assistant", "remove"),
      {
        appendParentId: "root",
        id: "rewind",
        parentId: "abandoned",
        targetId: "root",
        type: "leaf",
      },
    ],
    expected: {
      leafEventId: "root",
      activeRows: activeRows(1),
      ftsRows: [ftsRow("root", "user", "keep", 1_000)],
    },
  },
  {
    name: "legacy flat-message ordering and searchable identities",
    version: 1,
    events: [
      message("legacy-user", undefined, "user", "first"),
      message("legacy-assistant", undefined, "assistant", "second"),
    ],
    expected: {
      activeRows: activeRows(1, 2),
      ftsRows: [
        ftsRow("legacy-user", "user", "first", 1_000),
        ftsRow("legacy-assistant", "assistant", "second", 2_000),
      ],
      sourceIndexedSeq: 2,
    },
  },
])("projects $name", ({ version, events, createdAt, expected }) => {
  const db = projectionFixture(false);
  db.prepare("UPDATE session_windows SET transcript_updated_at=42 WHERE session_id='target'").run();
  db.prepare(
    "INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at) VALUES ('target', 'projection-generation', 42)",
  ).run();
  const insert = db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('target', ?, ?, ?)",
  );
  insert.run(0, JSON.stringify({ id: "target", type: "session", version }), 0);
  events.forEach((event, index) =>
    insert.run(index + 1, JSON.stringify(event), createdAt?.[index] ?? (index + 1) * 1_000),
  );
  const result = prepareProjection(db, "target");
  expect(result).toEqual(expect.objectContaining(expected));
});
