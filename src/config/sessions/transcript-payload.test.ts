import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
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
  prepareTranscriptPayload,
  prepareTranscriptPayloadForReuse,
  readTranscriptPayload,
  transcriptEventJsonSql,
  transcriptEventModelBytesSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
  transcriptEventWithoutCustomDataBytesSql,
  type TranscriptPayloadRecord,
} from "./transcript-payload.js";

type PayloadDatabase = { transcript_events: TranscriptPayloadRecord & { seq: number } };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nativeFixtureEvent =
  /* kysely-allow-raw: fixed identity fixture column provides the independent native comparison. */ sql.ref<string>(
    "transcript_events.event_json",
  );

function createTable(database: DatabaseSync): void {
  // Deliberately omit production constraints so reads also exercise corrupted persisted records.
  database.exec(`CREATE TABLE transcript_events (
    seq INTEGER PRIMARY KEY, event_json TEXT, event_zstd BLOB,
    event_utf8_bytes INTEGER, navigation_json TEXT
  ) STRICT`);
}

function insert(database: DatabaseSync, seq: number, row: TranscriptPayloadRecord): void {
  database
    .prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)")
    .run(seq, row.event_json, row.event_zstd, row.event_utf8_bytes, row.navigation_json);
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

function compressedRecord(bytes: Uint8Array, rawBytes = bytes.byteLength): TranscriptPayloadRecord {
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

describe("transcript payload storage boundary", () => {
  it.each([["UTF-16le", "UTF-8"]])(
    "recomputes a prepared %s frame for %s storage",
    (sourceEncoding, targetEncoding) => {
      const source = openNodeSqliteDatabase(":memory:");
      const target = openNodeSqliteDatabase(":memory:");
      try {
        source.exec(`PRAGMA encoding = '${sourceEncoding}'`);
        target.exec(`PRAGMA encoding = '${targetEncoding}'`);
        createTable(source);
        createTable(target);
        target.exec(`ALTER TABLE transcript_events ADD COLUMN session_id TEXT;
        ALTER TABLE transcript_events ADD COLUMN created_at INTEGER`);
        const eventJson = `{"type":"custom","id":"first","id":"last","data":"${"fixture".repeat(1024)}"}`;
        const prepared = prepareTranscriptPayloadForReuse(source, eventJson);
        expect(prepared.storageEncoding).toBe(sourceEncoding);
        const insertEvent = createTranscriptEventInserter(target, "session");
        insertEvent({
          seq: 1,
          eventJson,
          createdAt: 1,
          preparedPayload: prepared,
        });
        const stored = target
          .prepare(
            "SELECT event_json, event_zstd, event_utf8_bytes, navigation_json FROM transcript_events",
          )
          .get();
        expect(readBody(target, 1)).toBe(eventJson);
        expect(readBody(target, 1, "row")).toBe(eventJson);
        if (targetEncoding === "UTF-8") {
          expect(stored?.event_json).toBeNull();
          expect(stored?.event_zstd).toBeInstanceOf(Uint8Array);
          expect(stored?.event_utf8_bytes).toBe(Buffer.byteLength(eventJson));
        } else {
          expect(stored).toEqual({
            event_json: eventJson,
            event_zstd: null,
            event_utf8_bytes: null,
            navigation_json: null,
          });
        }
      } finally {
        source.close();
        target.close();
      }
    },
  );

  it("keeps malformed, giant and oversized-navigation identities usable without the codec", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const originals = [
        "",
        '{"type":"custom", invalid',
        `{"type":"custom","data":"${"x".repeat(2048)}`,
        `{"type":"custom","data":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
        `{"type":"message","id":"nested","parentId":null,"appendMode":${"[".repeat(998)}0${"]".repeat(998)},"message":{"role":"user","content":"${"x".repeat(12 * 1024)}"}}`,
        `{"type":"custom","data":"${"x".repeat(4 * 1024 * 1024)}"}`,
        `{"type":"message","message":{"provenance":{"extra":"${"x".repeat(17 * 1024)}"}}}`,
        '{"type":"custom","id":"\\ud800","data":"a\\u0000b"}',
        '{"type":"custom","data":"literal\0nul"}',
        "null",
      ];
      for (const [seq, original] of originals.entries()) {
        const prepared = prepareTranscriptPayload(database, original);
        expect(prepared).toEqual({
          event_json: original,
          event_zstd: null,
          event_utf8_bytes: Buffer.byteLength(original),
          navigation_json: null,
        });
        insert(database, seq, prepared);
        expect(readBody(database, seq)).toBe(original);
        expect(readBody(database, seq, "row")).toBe(original);
      }
    } finally {
      database.close();
    }
  });

  it.each([[3]])("keeps a genuine large header in identity storage with version %j", (version) => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      const original = JSON.stringify({
        type: "session",
        id: "header",
        version,
        padding: "x".repeat(4096),
      });
      const payload = prepareTranscriptPayload(database, original);
      expect(payload).toEqual({
        event_json: original,
        event_zstd: null,
        event_utf8_bytes: Buffer.byteLength(original),
        navigation_json: null,
      });
    } finally {
      database.close();
    }
  });

  it.each(["text fallback"])("preserves owner projections with %s JSON", (mode) => {
    const jsonb =
      mode === "text fallback"
        ? vi.spyOn(nodeSqlite, "supportsNodeSqliteJsonb").mockReturnValue(false)
        : undefined;
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const original = `{"type":"message","type":"reset","id":"first","id":"last","parentId":"parent","targetId":"target","appendParentId":"append","appendMode":"preserve","firstKeptEntryId":"kept","timestamp":"2026-01-01","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"large":"${"argument ".repeat(mode === "large" ? 256 * 1024 : 512)}"}}],"providerReplay":{"type":"checkpoint","data":"opaque"}},"message":{"role":"user","role":"toolResult","toolCallId":"call"}}`;
      const prepared = prepareTranscriptPayload(database, original);
      expect(prepared.event_zstd).not.toBeNull();
      insert(database, 0, {
        event_json: original,
        event_zstd: null,
        event_utf8_bytes: null,
        navigation_json: null,
      });
      insert(database, 1, prepared);
      const db = getNodeSqliteKysely<PayloadDatabase>(database);
      const stored = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            transcriptEventNavigationSql().as("navigation"),
            transcriptEventResetNavigationSql().as("reset"),
            transcriptEventModelNavigationSql().as("model"),
            transcriptEventModelBytesSql(sql.lit(0)).as("modelBytes"),
            transcriptEventModelBytesSql(sql.lit(1)).as("modelWithoutCheckpointBytes"),
            transcriptEventWithoutCustomDataBytesSql().as("withoutCustomDataBytes"),
            eb
              .fn<string>("json_extract", [transcriptEventNavigationSql(), eb.val("$.type")])
              .as("first_type"),
            eb
              .fn<string>("json_extract", [
                transcriptEventNavigationSql(),
                eb.val("$.message.role"),
              ])
              .as("first_role"),
          ])
          .where("seq", "=", 1),
      );
      const native = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            projectResetBoundaryNavigationSql(nativeFixtureEvent).as("reset"),
            projectModelContextNavigationSql(nativeFixtureEvent).as("model"),
            eb
              .fn<number>("octet_length", [
                projectModelContextEventSql(nativeFixtureEvent, sql.lit(0)),
              ])
              .as("modelBytes"),
            eb
              .fn<number>("octet_length", [
                projectModelContextEventSql(nativeFixtureEvent, sql.lit(1)),
              ])
              .as("modelWithoutCheckpointBytes"),
            eb
              .fn<number>("octet_length", [
                eb.fn<string>("json_remove", [nativeFixtureEvent, eb.val("$.data")]),
              ])
              .as("withoutCustomDataBytes"),
          ])
          .where("seq", "=", 0),
      );
      expect(stored?.first_type).toBe("message");
      expect(stored?.first_role).toBe("assistant");
      expect(JSON.parse(stored!.navigation)).toMatchObject({
        type: "reset",
        id: "last",
        targetId: "target",
        appendParentId: "append",
        appendMode: "preserve",
        firstKeptEntryId: "kept",
        message: { role: "toolResult" },
      });
      expect(stored).toMatchObject(native!);
      expect(readBody(database, 1)).toBe(original);
      expect(JSON.parse(stored!.model).message.content).toEqual([
        { type: "toolCall", id: "call", name: "read" },
      ]);
      expect(JSON.parse(stored!.model).message.providerReplay).toEqual({ type: "checkpoint" });
    } finally {
      database.close();
      jsonb?.mockRestore();
    }
  });

  it.each(['"message":{"timestamp":1}'])(
    "projects selected payloads once with native role semantics: %s",
    (envelope) => {
      const database = openNodeSqliteDatabase(":memory:");
      const decompress = vi.spyOn(resolveZstdCodec()!, "decompress");
      try {
        createTable(database);
        const fields =
          ',"content":[{"type":"text","text":"visible"}],"details":{"receipt":true},"__openclaw":{"upstreamUserText":"private"},"providerReplay":{"type":"checkpoint","data":"opaque"}';
        const original = `{"type":"message","data":"${"payload ".repeat(1024)}",${envelope.replaceAll("}", `${fields}}`)}}`;
        const prepared = prepareTranscriptPayload(database, original);
        expect(prepared.event_zstd !== null).toBe(
          !envelope.includes("scalar") && !envelope.includes("42"),
        );
        insert(database, 0, {
          event_json: original,
          event_zstd: null,
          event_utf8_bytes: null,
          navigation_json: null,
        });
        insert(database, 1, prepared);
        const db = getNodeSqliteKysely<PayloadDatabase>(database);
        for (const omitCheckpoint of [0, 1]) {
          for (const omission of [undefined, sql.val("body omitted")]) {
            const native = executeSqliteQueryTakeFirstSync(
              database,
              db
                .selectFrom("transcript_events")
                .select(
                  projectModelContextEventSql(
                    nativeFixtureEvent,
                    sql.val(omitCheckpoint),
                    omission,
                  ).as("event"),
                )
                .where("seq", "=", 0),
            );
            for (const seq of [0, 1]) {
              decompress.mockClear();
              const stored = executeSqliteQueryTakeFirstSync(
                database,
                db
                  .selectFrom("transcript_events")
                  .select((eb) =>
                    projectModelContextEventSql(
                      transcriptEventJsonSql(database),
                      eb.val(omitCheckpoint),
                      omission,
                      eb.fn("json_extract", [
                        transcriptEventNavigationSql(),
                        eb.val("$.message.role"),
                      ]),
                    ).as("event"),
                  )
                  .where("seq", "=", seq),
              );
              expect(stored).toEqual(native);
              expect(decompress).toHaveBeenCalledTimes(seq === 1 && prepared.event_zstd ? 1 : 0);
            }
          }
        }
      } finally {
        decompress.mockRestore();
        database.close();
      }
    },
  );

  it("bounds malformed frames and rejects size, checksum and UTF-8 corruption", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
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
      expect(readBody(database, records.length)).toBe(withBom.toString("utf8"));
      expect(readBody(database, records.length, "row")).toBe(withBom.toString("utf8"));
    } finally {
      database.close();
    }
  });

  it("materializes selected identity and compressed message rows without decoding excluded corruption", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
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
    } finally {
      database.close();
    }
  });

  it("registers on fresh read-only connections but refuses schema-triggered decoding", () => {
    const filename = path.join(tempDirs.make("transcript-payload-"), "payload.sqlite");
    const writer = openNodeSqliteDatabase(filename);
    const original = `{"type":"custom","data":"${"fixture".repeat(512)}"}`;
    try {
      createTable(writer);
      insert(writer, 1, prepareTranscriptPayload(writer, original));
      const body = transcriptEventJsonSql(writer).compile(getNodeSqliteKysely(writer));
      writer.exec(
        `CREATE VIEW decoded_payload AS SELECT ${body.sql} AS body FROM transcript_events`,
      );
      expect(() => writer.prepare("SELECT * FROM decoded_payload").get()).toThrow();
    } finally {
      writer.close();
    }
    const reader = openNodeSqliteDatabase(filename, { readOnly: true });
    try {
      reader.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF");
      expect(readBody(reader, 1)).toBe(original);
      expect(readBody(reader, 1, "row")).toBe(original);
      expect(() => reader.prepare("SELECT * FROM decoded_payload").get()).toThrow();
    } finally {
      reader.close();
    }
  });
});
