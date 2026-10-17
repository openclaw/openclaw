import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql, type AliasableExpression, type RawBuilder } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import {
  getMessageRangeReaders,
  parseActiveTranscriptMessageRow,
} from "./session-accessor.sqlite-projection-read.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
} from "./session-model-context-projection.js";
import {
  createTranscriptEventInserter,
  createTranscriptPayloadUpdater,
  prepareTranscriptPayload,
  prepareTranscriptPayloadForReuse,
  readTranscriptPayload,
  readTranscriptStorageEncoding,
  transcriptEventJsonSql,
  transcriptEventModelBytesSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
  transcriptEventWithoutCustomDataBytesSql,
  type TranscriptPayloadRecord,
} from "./transcript-payload.js";
import {
  deriveTranscriptPredicateFields,
  type TranscriptPredicateFields,
} from "./transcript-predicate-fields.js";

type PayloadDatabase = { transcript_events: TranscriptPayloadRecord & { seq: number } };
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function openDatabase(
  filename = ":memory:",
  options?: Parameters<typeof openNodeSqliteDatabase>[1],
  encoding?: string,
) {
  const database = openNodeSqliteDatabase(filename, options);
  databases.push(database);
  if (!options?.readOnly) {
    if (encoding) {
      database.exec(`PRAGMA encoding = '${encoding}'`);
    }
    createTable(database);
  }
  return database;
}
const nativeFixtureEvent =
  /* kysely-allow-raw: fixed identity fixture column provides the independent native comparison. */ sql.ref<string>(
    "transcript_events.event_json",
  );

function createTable(database: DatabaseSync): void {
  // Deliberately omit production constraints so reads also exercise corrupted persisted records.
  database.exec(`CREATE TABLE transcript_events (
    seq INTEGER PRIMARY KEY, event_json TEXT, event_zstd BLOB,
    event_utf8_bytes INTEGER, navigation_json TEXT,
    navigation_type TEXT, navigation_custom_type TEXT, navigation_display INTEGER NOT NULL DEFAULT 0,
    message_role TEXT, navigation_last_type TEXT, navigation_last_custom_type TEXT,
    navigation_valid INTEGER NOT NULL DEFAULT 1
  ) STRICT`);
  admitSqliteSchema(database);
}

type PayloadFixture = Omit<TranscriptPayloadRecord, keyof TranscriptPredicateFields> &
  Partial<TranscriptPredicateFields>;

function insert(database: DatabaseSync, seq: number, row: PayloadFixture): void {
  const fields = {
    ...deriveTranscriptPredicateFields(row.event_json ?? row.navigation_json ?? "null"),
    ...row,
  };
  const values = { seq, ...fields };
  const columns = Object.keys(values);
  database
    .prepare(
      `INSERT INTO transcript_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(values));
}

function select<T>(database: DatabaseSync, seq: number, expression: AliasableExpression<T>) {
  return executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<PayloadDatabase>(database)
      .selectFrom("transcript_events")
      .where("seq", "=", seq)
      .select(expression.as("value")),
  )?.value;
}

function readBody(database: DatabaseSync, seq: number, mode: "sql" | "row" = "sql") {
  const query = getNodeSqliteKysely<PayloadDatabase>(database)
    .selectFrom("transcript_events as event")
    .where("seq", "=", seq);
  if (mode === "row") {
    const row = executeSqliteQueryTakeFirstSync(
      database,
      query.select(["event.event_json", "event.event_zstd", "event.event_utf8_bytes"]),
    );
    return row && readTranscriptPayload(row);
  }
  return executeSqliteQueryTakeFirstSync(
    database,
    query.select(transcriptEventJsonSql(database, "event").as("body")),
  )?.body;
}

function compressedRecord(bytes: Uint8Array, rawBytes = bytes.byteLength): PayloadFixture {
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("Transcript compression boundary tests require native zstd support");
  }
  return {
    event_json: null,
    event_zstd: codec.compress(bytes, 1, true),
    event_utf8_bytes: rawBytes,
    navigation_json: '{"type":"custom"}',
  };
}

function expectBody(database: DatabaseSync, seq: number, original: string) {
  expect(readBody(database, seq)).toBe(original);
  expect(readBody(database, seq, "row")).toBe(original);
}
function expectedIdentity(
  original: string,
  type: string | null,
  role: string | null = null,
  valid = 1,
) {
  return {
    event_json: original,
    event_zstd: null,
    event_utf8_bytes: Buffer.byteLength(original),
    navigation_json: null,
    navigation_type: type,
    navigation_custom_type: null,
    navigation_display: 0,
    message_role: role,
    navigation_last_type: type,
    navigation_last_custom_type: null,
    navigation_valid: valid,
  };
}
function identityRecord(eventJson: string): PayloadFixture {
  return { event_json: eventJson, event_zstd: null, event_utf8_bytes: null, navigation_json: null };
}
function insertComparedPayloads(database: DatabaseSync, original: string) {
  const prepared = prepareTranscriptPayload(database, original);
  expect(prepared.event_zstd).not.toBeNull();
  insert(database, 0, identityRecord(original));
  insert(database, 1, prepared);
  return prepared;
}

describe("transcript payload storage boundary", () => {
  it("publishes predicate columns with inserts and rewrites and rolls both back together", () => {
    const database = openDatabase();
    database.exec(`ALTER TABLE transcript_events ADD COLUMN session_id TEXT;
        ALTER TABLE transcript_events ADD COLUMN created_at INTEGER`);
    const write = createTranscriptEventInserter(database, "session");
    write({
      seq: 1,
      createdAt: 1,
      eventJson: '{"type":"message","message":{"role":"user","role":"assistant"}}',
    });
    const read = () =>
      database
        .prepare(`SELECT navigation_type, navigation_last_type,
        navigation_display, message_role, navigation_valid FROM transcript_events WHERE seq = 1`)
        .get();
    const originalPredicates = {
      navigation_type: "message",
      navigation_last_type: "message",
      navigation_display: 0,
      message_role: "user",
      navigation_valid: 1,
    };
    expect(read()).toEqual(originalPredicates);
    database.exec("BEGIN");
    createTranscriptPayloadUpdater(
      database,
      "session",
    )({
      seq: 1,
      ...prepareTranscriptPayload(
        database,
        '{"type":"custom_message","type":"reset","display":true}',
      ),
    });
    expect(read()).toEqual({
      navigation_type: "custom_message",
      navigation_last_type: "reset",
      navigation_display: 1,
      message_role: null,
      navigation_valid: 1,
    });
    database.exec("ROLLBACK");
    expect(read()).toEqual(originalPredicates);
  });

  it.each([
    ["UTF-16le", "UTF-8"],
    ["UTF-8", "UTF-16le"],
  ])("recomputes a prepared %s frame for %s storage", (sourceEncoding, targetEncoding) => {
    const source = openDatabase(":memory:", undefined, sourceEncoding);
    const target = openDatabase(":memory:", undefined, targetEncoding);
    const observation = observeSqliteReadSql(
      nodeSqlite.requireNodeSqlite().StatementSync.prototype,
    );
    try {
      expect(readTranscriptStorageEncoding(source)).toBe(sourceEncoding);
      expect(readTranscriptStorageEncoding(target)).toBe(targetEncoding);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
    target.exec(`ALTER TABLE transcript_events ADD COLUMN session_id TEXT;
      ALTER TABLE transcript_events ADD COLUMN created_at INTEGER`);
    const eventJson = `{"type":"custom","id":"first","id":"last","data":"${"fixture".repeat(1024)}"}`;
    const prepared = prepareTranscriptPayloadForReuse(source, eventJson);
    expect(prepared.storageEncoding).toBe(sourceEncoding);
    createTranscriptEventInserter(
      target,
      "session",
    )({ seq: 1, eventJson, createdAt: 1, preparedPayload: prepared });
    const stored = target
      .prepare(
        "SELECT event_json, event_zstd, event_utf8_bytes, navigation_json FROM transcript_events",
      )
      .get();
    expectBody(target, 1, eventJson);
    if (targetEncoding === "UTF-8") {
      expect(stored).toMatchObject({
        event_json: null,
        event_zstd: expect.any(Uint8Array),
        event_utf8_bytes: Buffer.byteLength(eventJson),
      });
    } else {
      expect(stored).toEqual({
        event_json: eventJson,
        event_zstd: null,
        event_utf8_bytes: null,
        navigation_json: null,
      });
    }
  });

  it("keeps malformed, giant and oversized-navigation identities usable without the codec", () => {
    const database = openDatabase();
    const nested = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    const originals: [string, string | null, (string | null)?, number?][] = [
      ["", null, null, 0],
      ['{"type":"custom", invalid', null, null, 0],
      [`{"type":"custom","data":"${"x".repeat(2048)}`, null, null, 0],
      [`{"type":"custom","data":${nested(1001)}}`, null, null, 0],
      [
        `{"type":"message","id":"nested","parentId":null,"appendMode":${nested(998)},"message":{"role":"user","content":"${"x".repeat(12 * 1024)}"}}`,
        "message",
        "user",
      ],
      [`{"type":"custom","data":"${"x".repeat(4 * 1024 * 1024)}"}`, "custom"],
      [
        `{"type":"message","message":{"provenance":{"extra":"${"x".repeat(17 * 1024)}"}}}`,
        "message",
      ],
      ['{"type":"custom","id":"\\ud800","data":"a\\u0000b"}', "custom"],
      ['{"type":"custom","data":"literal\0nul"}', null, null, 0],
      ["null", null],
    ];
    for (const [seq, [original, type, role = null, valid = 1]] of originals.entries()) {
      const prepared = prepareTranscriptPayload(database, original);
      expect(prepared).toEqual(expectedIdentity(original, type, role, valid));
      insert(database, seq, prepared);
      expectBody(database, seq, original);
    }
  });

  it("keeps a genuine large header in identity storage with version 3", () => {
    const database = openDatabase();
    const original = `{"type":"session","id":"header","version":3,"padding":"${"x".repeat(4096)}"}`;
    const payload = prepareTranscriptPayload(database, original);
    expect(payload).toEqual(expectedIdentity(original, "session"));
  });

  it("preserves owner projections with text fallback JSON", () => {
    vi.spyOn(nodeSqlite, "supportsNodeSqliteJsonb").mockReturnValue(false);
    const database = openDatabase();
    const original = `{"type":"message","type":"reset","id":"first","id":"last","parentId":"parent","targetId":"target","appendParentId":"append","appendMode":"preserve","firstKeptEntryId":"kept","timestamp":"2026-01-01","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"large":"${"argument ".repeat(512)}"}}],"providerReplay":{"type":"checkpoint","data":"opaque"}},"message":{"role":"user","role":"toolResult","toolCallId":"call"}}`;
    insertComparedPayloads(database, original);
    const db = getNodeSqliteKysely<PayloadDatabase>(database);
    const bytes = (event: RawBuilder<string>) => db.fn<number>("octet_length", [event]);
    const navigation = transcriptEventNavigationSql(database);
    const field = (jsonPath: string) =>
      db.fn<string>("json_extract", [navigation, sql.val(jsonPath)]);
    expect([
      select(database, 1, field("$.type")),
      select(database, 1, field("$.message.role")),
    ]).toEqual(["message", "assistant"]);
    expect(JSON.parse(select(database, 1, navigation)!)).toMatchObject({
      type: "reset",
      id: "last",
      targetId: "target",
      appendParentId: "append",
      appendMode: "preserve",
      firstKeptEntryId: "kept",
      message: { role: "toolResult" },
    });
    for (const [stored, native] of [
      [
        transcriptEventResetNavigationSql(database),
        projectResetBoundaryNavigationSql(database, nativeFixtureEvent),
      ],
      [
        transcriptEventModelNavigationSql(database),
        projectModelContextNavigationSql(database, nativeFixtureEvent),
      ],
      [
        transcriptEventWithoutCustomDataBytesSql(database),
        bytes(db.fn<string>("json_remove", [nativeFixtureEvent, sql.val("$.data")])),
      ],
    ] as const) {
      expect(select<unknown>(database, 1, stored)).toEqual(select<unknown>(database, 0, native));
    }
    for (const omit of [sql.lit(0), sql.lit(1)]) {
      const stored = transcriptEventModelBytesSql(database, omit);
      const native = bytes(projectModelContextEventSql(database, nativeFixtureEvent, omit));
      expect(select(database, 1, stored)).toEqual(select(database, 0, native));
    }
    expect(readBody(database, 1)).toBe(original);
    const { content, providerReplay } = JSON.parse(
      select(database, 1, transcriptEventModelNavigationSql(database))!,
    ).message;
    expect({ content, providerReplay }).toEqual({
      content: [{ type: "toolCall", id: "call", name: "read" }],
      providerReplay: { type: "checkpoint" },
    });
  });

  it("projects selected payloads once with native role semantics", () => {
    const database = openDatabase();
    const decompress = vi.spyOn(resolveZstdCodec()!, "decompress");
    const fields =
      ',"content":[{"type":"text","text":"visible"}],"details":{"receipt":true},"__openclaw":{"upstreamUserText":"private"},"providerReplay":{"type":"checkpoint","data":"opaque"}';
    const original = `{"type":"message","data":"${"payload ".repeat(1024)}","message":{"timestamp":1${fields}}}`;
    const prepared = insertComparedPayloads(database, original);
    const db = getNodeSqliteKysely<PayloadDatabase>(database);
    const role = db.fn("json_extract", [
      transcriptEventNavigationSql(database),
      sql.val("$.message.role"),
    ]);
    for (const omitCheckpoint of [0, 1]) {
      for (const omission of [undefined, sql.val("body omitted")]) {
        const project = (event: RawBuilder<string>, projectedRole?: typeof role) =>
          projectModelContextEventSql(
            database,
            event,
            sql.val(omitCheckpoint),
            omission,
            projectedRole,
          );
        const native = select(database, 0, project(nativeFixtureEvent));
        for (const seq of [0, 1]) {
          decompress.mockClear();
          const stored = select(database, seq, project(transcriptEventJsonSql(database), role));
          expect(stored).toEqual(native);
          expect(decompress).toHaveBeenCalledTimes(seq === 1 && prepared.event_zstd ? 1 : 0);
        }
      }
    }
  });

  it("bounds malformed frames and rejects size, checksum and UTF-8 corruption", () => {
    const database = openDatabase();
    const original = Buffer.from('{"type":"custom"}');
    const damaged = compressedRecord(original);
    const damagedBytes = Buffer.from(damaged.event_zstd!);
    const checksumOffset = damagedBytes.length - 1;
    damagedBytes.writeUInt8(damagedBytes.readUInt8(checksumOffset) ^ 1, checksumOffset);
    const records = [
      { ...damaged, event_zstd: damagedBytes },
      compressedRecord(original, original.byteLength - 1),
      compressedRecord(original, original.byteLength + 1),
      compressedRecord(Buffer.from([0xff])),
      compressedRecord(Buffer.alloc(4 * 1024 * 1024 + 1), 4 * 1024 * 1024),
      { ...damaged, event_utf8_bytes: 4 * 1024 * 1024 + 1 },
      { ...damaged, event_zstd: Buffer.alloc(4 * 1024 * 1024 + 1) },
      { ...damaged, event_utf8_bytes: null },
    ];
    for (const [seq, record] of records.entries()) {
      insert(database, seq, record);
      expect(() => readBody(database, seq)).toThrow();
      expect(() => readBody(database, seq, "row")).toThrow();
    }
    const withBom = Buffer.from('\ufeff{"type":"custom"}');
    insert(database, records.length, compressedRecord(withBom));
    expectBody(database, records.length, withBom.toString("utf8"));
  });

  it("materializes selected identity and compressed message rows without decoding excluded corruption", () => {
    const database = openDatabase();
    const messages = [
      { type: "message", id: "identity", message: { role: "user", content: "identity 🦞" } },
      {
        type: "message",
        id: "compressed",
        message: { role: "assistant", content: "雪🦞".repeat(4096) },
      },
    ];
    insert(database, 0, {
      event_json: null,
      event_zstd: Buffer.from([1, 2, 3]),
      event_utf8_bytes: 4096,
      navigation_json: null,
    });
    for (const [index, message] of messages.entries()) {
      insert(database, index + 1, prepareTranscriptPayload(database, JSON.stringify(message)));
    }
    database.exec(`ALTER TABLE transcript_events ADD COLUMN session_id TEXT DEFAULT 'selected';
        CREATE TABLE session_transcript_active_events (
          session_id TEXT, event_seq INTEGER, message_position INTEGER
        );
        INSERT INTO session_transcript_active_events VALUES ('selected', 0, 0), ('selected', 1, 1), ('selected', 2, 2)`);
    const readers = getMessageRangeReaders({ db: database, agentId: "main", path: ":memory:" });
    const range = { sessionId: "selected", start: 1, endExclusive: 3 };
    const events = Array.from(readers.messages(range), parseActiveTranscriptMessageRow);
    expect(events).toEqual(
      messages.map((event, index) => ({ event, eventSeq: index + 1, seq: index + 2 })),
    );
    expect(parseActiveTranscriptMessageRow(readers.latest(range)!)).toEqual(events[1]);
    expect(() =>
      Array.from(readers.messages({ ...range, start: 0 }), parseActiveTranscriptMessageRow),
    ).toThrow();
  });

  it("registers on fresh read-only connections but refuses schema-triggered decoding", () => {
    const filename = path.join(tempDirs.make("transcript-payload-"), "payload.sqlite");
    const writer = openDatabase(filename);
    const original = `{"type":"custom","data":"${"fixture".repeat(512)}"}`;
    insert(writer, 1, prepareTranscriptPayload(writer, original));
    const body = transcriptEventJsonSql(writer).compile(getNodeSqliteKysely(writer));
    writer.exec(`CREATE VIEW decoded_payload AS SELECT ${body.sql} AS body FROM transcript_events`);
    expect(() => writer.prepare("SELECT * FROM decoded_payload").get()).toThrow();
    writer.close();
    const reader = openDatabase(filename, { readOnly: true });
    reader.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
    expectBody(reader, 1, original);
    expect(() => reader.prepare("SELECT * FROM decoded_payload").get()).toThrow();
  });
});
