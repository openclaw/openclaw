import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import * as transcriptFts from "./session-transcript-fts.js";
import {
  createSessionTranscriptFtsInserter as createFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction as deleteFtsRows,
  selectSessionTranscriptFtsRows as selectFtsRows,
} from "./session-transcript-fts.js";
import {
  createTranscriptIndexAppenderInTransaction as createIndexAppender,
  reconcileSessionTranscriptIndexInTransaction as reconcileIndex,
  deleteSessionTranscriptIndexInTransaction as deleteIndex,
  markSessionTranscriptIndexDirtyInTransaction as markIndexDirty,
  replaceSessionTranscriptIndexSuffixInTransaction as replaceIndexSuffix,
} from "./session-transcript-index.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction as appendProjectionChunk,
  claimPreparedSessionTranscriptProjectionInTransaction as claimProjection,
  deletePreparedSessionTranscriptProjectionChunkInTransaction as deleteProjectionChunk,
  finalizePreparedSessionTranscriptProjectionInTransaction as finalizeProjection,
  prepareProjectionSource,
  prepareSessionTranscriptProjection as prepareStreamingProjection,
} from "./session-transcript-projection-rebuild.js";
import { messageEvent } from "./transcript-message.test-support.js";
import {
  createTranscriptEventInserter,
  transcriptSerializedBytes,
  transcriptEventDependencyNavigationSql,
} from "./transcript-payload.js";

function prepareProjection(...args: Parameters<typeof prepareStreamingProjection>) {
  const plan = prepareStreamingProjection(...args);
  return plan ? { ...plan, ftsRows: [...plan.ftsRows] } : undefined;
}

const projectionDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of projectionDatabases.splice(0)) {
    db.close();
  }
});

function rows(db: EngineConnection, statement: string) {
  return db.prepare(statement).all();
}

it("preserves exact 64-bit identities, duplicates and cold rows through deletion and rollback", () => {
  const db = projectionFixture(false);
  const expectedRows = [
    { message_id: "duplicate", text: "first searchable", role: "user", timestamp: 10 },
    { message_id: "duplicate", text: "second searchable", role: "assistant", timestamp: "10" },
    { message_id: null, text: null, role: null, timestamp: null },
  ];
  runSqliteImmediateTransactionSync(db, () => {
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
  });
  expect(
    rows(
      db,
      "SELECT CAST(rowid AS TEXT) AS id, session_id, message_id FROM session_transcript_fts ORDER BY rowid",
    ),
  ).toEqual([
    { id: "9007199254740992", session_id: "other", message_id: "duplicate" },
    { id: "9007199254740993", session_id: "session", message_id: "duplicate" },
    { id: "9007199254740994", session_id: "session", message_id: "duplicate" },
    { id: "9007199254740995", session_id: "session", message_id: null },
  ]);
  const read = () => executeSqliteQuerySync(db, selectFtsRows(db, "session")).rows;
  const before = read();
  expect(before).toEqual(expectedRows);

  expect(() =>
    runSqliteImmediateTransactionSync(db, () => {
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
    }),
  ).toThrow("roll back both projections");
  expect(read()).toEqual(before);

  runSqliteImmediateTransactionSync(db, () => {
    expect(deleteFtsRows(db, "session", { messageIds: [] })).toBe(0);
    expect(deleteFtsRows(db, "session", { messageIds: ["duplicate"] })).toBe(2);
    expect(read()).toEqual([before[2]]);
    expect(deleteFtsRows(db, "session", { maxRows: 1 })).toBe(1);
    expect(deleteFtsRows(db, "session", { maxRows: 1 })).toBe(0);
  });
  expect(db.prepare("SELECT session_id, text FROM session_transcript_fts").all()).toEqual([
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
    const insert = inserters.get(id)!;
    const eventJson = JSON.stringify(event);
    const preparedPayload = insert.prepare({ seq, eventJson, createdAt: seq });
    insert({ seq, eventJson, createdAt: seq, preparedPayload });
    appenders.get(id)!.append({
      seq,
      event,
      eventId,
      createdAt: seq,
      preparedPayload,
      serializedBytes: transcriptSerializedBytes(db, eventJson),
    });
  }
  for (const appender of appenders.values()) {
    appender.flush();
  }
  db.exec("COMMIT");
  return db;
}

// Cost budget: six messages, less than 1 MiB total text, one in-memory production rebuild.
it("bounds rebuild FTS batches by UTF-8 bytes without dropping oversized rows", () => {
  const db = projectionFixture(false);
  const texts = [
    "界".repeat(64 * 1024),
    "界".repeat(64 * 1024),
    "界".repeat(64 * 1024),
    "x".repeat(300 * 1024),
    "needle tail",
    "last",
  ];
  const insertEvent = createTranscriptEventInserter(db, "target");
  runSqliteImmediateTransactionSync(db, () => {
    texts.forEach((content, seq) => {
      const event = messageEvent(`target-${seq}`, seq ? `target-${seq - 1}` : null, {
        role: "user",
        content,
      });
      insertEvent({ seq, eventJson: JSON.stringify(event), createdAt: seq });
    });
  });
  const batches: { bytes: number; rows: number }[] = [];
  const realCreateInserter = transcriptFts.createSessionTranscriptFtsInserter;
  const spy = vi
    .spyOn(transcriptFts, "createSessionTranscriptFtsInserter")
    .mockImplementation((connection, sessionId) => {
      const insert = realCreateInserter(connection, sessionId);
      return (entries) => {
        if (entries.length) {
          batches.push({
            rows: entries.length,
            bytes: entries.reduce((sum, row) => sum + Buffer.byteLength(row.text ?? ""), 0),
          });
        }
        insert(entries);
      };
    });
  try {
    expect(runSqliteImmediateTransactionSync(db, () => reconcileIndex(db, "target"))).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(batches.every((batch) => batch.bytes <= 256 * 1024 || batch.rows === 1)).toBe(true);
  expect(batches.reduce((sum, batch) => sum + batch.rows, 0)).toBe(texts.length);
  expect(
    rows(
      db,
      "SELECT message_id, text FROM session_transcript_fts WHERE session_id = 'target' ORDER BY rowid",
    ),
  ).toEqual(texts.map((text, seq) => ({ message_id: `target-${seq}`, text })));
  expect(
    rows(
      db,
      "SELECT active_event_count, active_message_count, indexed_seq, needs_rebuild FROM session_transcript_index_state WHERE session_id = 'target'",
    ),
  ).toEqual([
    {
      active_event_count: texts.length,
      active_message_count: texts.length,
      indexed_seq: texts.length - 1,
      needs_rebuild: 0,
    },
  ]);
  expect(
    rows(
      db,
      "SELECT event_seq FROM session_transcript_active_events WHERE session_id = 'target' ORDER BY active_position",
    ),
  ).toEqual(texts.map((_, event_seq) => ({ event_seq })));
});

it("binds interleaved session payloads in the reused single-row facts writer", () => {
  const db = projectionFixture(false);
  const inputs = [
    ["target", messageEvent("first", null, { role: "user", content: "one" })],
    ["sibling", { type: "custom", id: "other", parentId: null, customType: "fixture" }],
    ["target", messageEvent("next", "first", { role: "assistant", content: "longer second" })],
  ] as const;
  for (const [index, [sessionId, event]] of inputs.entries()) {
    runSqliteImmediateTransactionSync(db, () => {
      const seq = index === 2 ? 1 : 0;
      const eventJson = JSON.stringify(event);
      const insert = createTranscriptEventInserter(db, sessionId);
      const preparedPayload = insert.prepare({ seq, eventJson, createdAt: 1 });
      insert({ seq, eventJson, createdAt: 1, preparedPayload });
      const append = createIndexAppender(db, sessionId);
      append.append({
        seq,
        event,
        eventId: event.id,
        createdAt: 1,
        preparedPayload,
        serializedBytes: transcriptSerializedBytes(db, eventJson),
      });
      append.flush();
    });
  }
  const facts = rows(
    db,
    "SELECT * FROM session_transcript_active_event_facts ORDER BY session_id, seq",
  );
  expect(facts.map((row) => [row.session_id, row.seq, row.serialized_bytes])).toEqual(
    [inputs[1], inputs[0], inputs[2]].map(([sessionId, event], index) => [
      sessionId,
      index === 2 ? 1 : 0,
      transcriptSerializedBytes(db, JSON.stringify(event)),
    ]),
  );
  expect(JSON.parse(String(facts[0]!.dependency_navigation_json))).toEqual(inputs[1][1]);
  expect(facts.slice(1).map((row) => row.dependency_navigation_json)).toEqual(["{}", "{}"]);
});

it("leaves unprojectable legacy placement facts unknown on append and rebuild", () => {
  const db = projectionFixture(false);
  const event = {
    type: "custom",
    id: "legacy-placement",
    parentId: null,
    customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
    data: "not-json",
  };
  const eventJson = JSON.stringify(event);
  runSqliteImmediateTransactionSync(db, () => {
    const insert = createTranscriptEventInserter(db, "target");
    const preparedPayload = insert.prepare({ seq: 0, eventJson, createdAt: 1 });
    insert({ seq: 0, eventJson, createdAt: 1, preparedPayload });
    const append = createIndexAppender(db, "target");
    append.append({
      seq: 0,
      event,
      eventId: event.id,
      createdAt: 1,
      preparedPayload,
      serializedBytes: transcriptSerializedBytes(db, eventJson),
    });
    append.flush();
  });
  expect(rows(db, "SELECT * FROM session_transcript_active_event_facts")).toEqual([]);
  const plan = prepareProjection(db, "target")!;
  expect(plan.activeRows).toHaveLength(1);
  expect(plan.activeRows[0]?.facts).toBeUndefined();
  runSqliteImmediateTransactionSync(db, () => {
    expect(claimProjection(db, plan, -1)).toBe(true);
    deleteProjectionChunk(db, { sessionId: "target", maxRowsPerTable: 512 });
    appendProjectionChunk(db, { sessionId: "target", activeRows: plan.activeRows });
    expect(finalizeProjection(db, plan, -1)).toBe(true);
  });
  expect(rows(db, "SELECT * FROM session_transcript_active_event_facts")).toEqual([]);
  expect(rows(db, "SELECT event_json FROM transcript_events")).toEqual([{ event_json: eventJson }]);
  const read = getNodeSqliteKysely<{ transcript_events: { event_json: string } }>(db)
    .selectFrom("transcript_events as event")
    .select(transcriptEventDependencyNavigationSql(db, sql.lit(1), "event").as("navigation"));
  expect(() => executeSqliteQuerySync(db, read)).toThrow(/malformed JSON/);

});

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

it("replaces a suffix larger than SQLite's parameter limit without touching siblings", () => {
  const db = projectionFixture();
  const siblings = hits(db).filter((row) => row.session_id === "sibling");
  const variableLimit = rows(db, "PRAGMA compile_options")
    .map((row) => String(row.compile_options))
    .find((option) => option.startsWith("MAX_VARIABLE_NUMBER="));
  const bulkRows = Number(variableLimit?.split("=")[1] ?? 32766) + 1;
  db.exec("BEGIN");
  createFtsInserter(
    db,
    "target",
  )(
    Array.from({ length: bulkRows }, (_, index) => ({
      messageId: `bulk-${index}`,
      text: `needle bulk-${index}`,
      role: "user",
      timestamp: index + 4,
    })),
  );
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

it("deletes projections without changing interleaved siblings", () => {
  const db = projectionFixture();
  const expected = hits(db);
  expect(rows(db, "SELECT * FROM session_transcript_active_event_facts")).toHaveLength(8);
  db.exec("BEGIN");
  deleteIndex(db, "target");
  db.exec("COMMIT");
  expect(hits(db)).toEqual(expected.filter((row) => row.session_id === "sibling"));
  expect(rows(db, "SELECT DISTINCT session_id FROM session_transcript_active_event_facts")).toEqual(
    [{ session_id: "sibling" }],
  );
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
  expect(rows(db, "SELECT * FROM session_transcript_active_event_facts")).toHaveLength(8);
});

function message(
  id: string,
  parentId: string | null | undefined,
  role: string,
  content: unknown,
  timestamp?: string,
) {
  return {
    ...messageEvent(id, parentId, { role, content }),
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
  expect(result).toEqual(
    expect.objectContaining({
      ...expected,
      ...(expected.activeRows
        ? { activeRows: expected.activeRows.map((row) => expect.objectContaining(row)) }
        : {}),
    }),
  );
  expect(result?.activeRows.every((row) => row.facts !== undefined)).toBe(true);
});

it("reads prepared FTS payloads only as the consumer advances", () => {
  const events = ["first", "second", "third"].map((id, index) => ({
    seq: index + 1,
    created_at: index + 10,
    event_json: JSON.stringify(
      messageEvent(id, index === 0 ? null : ["first", "second"][index - 1], {
        role: "user",
        content: [{ type: "text", text: id.repeat(10_000) }],
      }),
    ),
  }));
  let pointReads = 0;
  const plan = prepareProjectionSource({
    sessionId: "stream",
    transcriptGeneration: "generation",
    transcriptUpdatedAt: 1,
    rows: () => events,
    row: (seq) => {
      pointReads += 1;
      return events.find((event) => event.seq === seq);
    },
  });
  expect(plan).toMatchObject({ activeEventCount: 3, activeMessageCount: 3, sourceIndexedSeq: 3 });
  const planningReads = pointReads;
  const iterator = plan!.ftsRows[Symbol.iterator]();
  expect(pointReads).toBe(planningReads);
  for (const [index, id] of ["first", "second", "third"].entries()) {
    expect(iterator.next().value).toMatchObject({ messageId: id, text: id.repeat(10_000) });
    expect(pointReads).toBe(planningReads + index + 1);
  }
  expect(iterator.next().done).toBe(true);
  expect(pointReads).toBe(planningReads + 3);
});
