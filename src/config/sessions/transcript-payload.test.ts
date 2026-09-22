import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql, type RawBuilder } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
} from "./session-model-context-projection.js";
import {
  createTranscriptEventInserter,
  prepareTranscriptPayload,
  prepareTranscriptPayloadForReuse,
  transcriptEventJsonSql,
  transcriptEventModelBytesSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
  transcriptEventUtf8BytesSql,
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

function readBody(database: DatabaseSync, seq: number): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<PayloadDatabase>(database)
      .selectFrom("transcript_events as event")
      .select(transcriptEventJsonSql(database, "event").as("body"))
      .where("seq", "=", seq),
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

function inspectNavigation(database: DatabaseSync, event: RawBuilder<string>, seq: number) {
  const paths = [
    "$.type",
    "$.id",
    "$.parentId",
    "$.customType",
    "$.display",
    "$.message.role",
    "$.message.idempotencyKey",
    "$.message.provenance",
    "$.message.excludeFromContext",
    "$.message.__openclaw.runId",
    "$.message.__openclaw.steerTargetRunId",
    "$.message.__openclaw.contextFreeCommand",
  ];
  return paths.map((jsonPath) =>
    executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<PayloadDatabase>(database)
        .selectFrom("transcript_events")
        .select((eb) => [
          eb.fn<string | null>("json_type", [event, eb.val(jsonPath)]).as("type"),
          sql`CASE WHEN json_type(${event}, ${jsonPath}) IN ('object', 'array')
            THEN json(json_extract(${event}, ${jsonPath}))
            ELSE json_extract(${event}, ${jsonPath}) END`.as("value"),
        ])
        .where("seq", "=", seq),
    ),
  );
}

describe("transcript payload storage boundary", () => {
  it.each([
    ["UTF-8", "UTF-16le"],
    ["UTF-8", "UTF-16be"],
    ["UTF-16le", "UTF-8"],
    ["UTF-16be", "UTF-8"],
  ])("recomputes a prepared %s frame for %s storage", (sourceEncoding, targetEncoding) => {
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
  });

  it("keeps identity storage when navigation would outweigh compressed payload savings", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      for (const original of [
        '{"type":"message","message":{"role":"user","content":"short"}}',
        JSON.stringify({ type: "custom", id: "identifier".repeat(256), data: "small" }),
      ]) {
        expect(prepareTranscriptPayload(database, original)).toEqual({
          event_json: original,
          event_zstd: null,
          event_utf8_bytes: Buffer.byteLength(original),
          navigation_json: null,
        });
      }
    } finally {
      database.close();
    }
  });

  it("preserves exact canonical text while selecting metadata without the body", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const original = ` { "type": "custom", "id": "雪🦞", "data": "${"é ".repeat(4096)}", "number": 1.00, "duplicate": 1, "duplicate": 2 }\n`;
      const prepared = prepareTranscriptPayload(database, original);
      expect(prepared.event_json).toBeNull();
      expect(prepared.event_zstd?.byteLength).toBeLessThan(Buffer.byteLength(original) / 2);
      expect(
        prepared.event_zstd!.byteLength + Buffer.byteLength(prepared.navigation_json!),
      ).toBeLessThan(Buffer.byteLength(original));
      insert(database, 1, prepared);
      expect(readBody(database, 1)).toBe(original);
      expect(readBody(database, 1)).toBe(original);

      database.prepare("UPDATE transcript_events SET event_zstd = x'010203' WHERE seq = 1").run();
      const metadata = executeSqliteQueryTakeFirstSync(
        database,
        getNodeSqliteKysely<PayloadDatabase>(database)
          .selectFrom("transcript_events")
          .select([
            transcriptEventNavigationSql().as("navigation"),
            transcriptEventUtf8BytesSql().as("bytes"),
          ]),
      );
      expect(metadata?.bytes).toBe(Buffer.byteLength(original));
      expect(metadata?.navigation).not.toContain('"data"');
      expect(() => readBody(database, 1)).toThrow();
    } finally {
      database.close();
    }
  });

  it.each(["true", "1", '"true"', "null", "false"])(
    "preserves SQLite navigation types, missing keys and duplicate selection for %s",
    (booleanValue) => {
      const database = openNodeSqliteDatabase(":memory:");
      try {
        createTable(database);
        const original = `{"type":"custom_message","id":"雪🦞","parentId":null,"display":${booleanValue},"display":false,"message":{"role":"user","role":"assistant","idempotencyKey":"a-b","provenance":{"kind":"voice","sourceChannel":"雪🦞","extra":[true,null,1]},"excludeFromContext":${booleanValue},"__openclaw":{"runId":"run","steerTargetRunId":null,"contextFreeCommand":${booleanValue}},"content":"${"content ".repeat(512)}"}}`;
        insert(database, 0, {
          event_json: original,
          event_zstd: null,
          event_utf8_bytes: null,
          navigation_json: null,
        });
        const prepared = prepareTranscriptPayload(database, original);
        expect(prepared.event_zstd).not.toBeNull();
        insert(database, 1, prepared);
        expect(inspectNavigation(database, transcriptEventNavigationSql(), 1)).toEqual(
          inspectNavigation(database, nativeFixtureEvent, 0),
        );
        expect(readBody(database, 1)).toBe(original);
      } finally {
        database.close();
      }
    },
  );

  it("keeps malformed, giant and oversized-navigation identities usable without the codec", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const originals = [
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
      }
    } finally {
      database.close();
    }
  });

  it.each([3, "3", [3], { future: true }])(
    "keeps a genuine large header in identity storage with version %j",
    (version) => {
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
    },
  );

  it("retains native UTF-16 navigation and native projected byte accounting", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      database.exec("PRAGMA encoding = 'UTF-16le'");
      createTable(database);
      const original = `{"type":"custom_message","id":"雪🦞\\ud800","display":true,"data":"${"雪".repeat(1024)}"}`;
      const prepared = prepareTranscriptPayload(database, original);
      expect(prepared.navigation_json).toBeNull();
      expect(prepared.event_zstd).toBeNull();
      expect(prepared.event_utf8_bytes).toBeNull();
      insert(database, 1, prepared);
      expect(inspectNavigation(database, transcriptEventNavigationSql(), 1)).toEqual(
        inspectNavigation(database, nativeFixtureEvent, 1),
      );
      expect(readBody(database, 1)).toBe(original);
      const lengths = database
        .prepare(
          "SELECT octet_length(event_json) stored, event_utf8_bytes utf8 FROM transcript_events",
        )
        .get();
      expect(lengths?.utf8).toBeNull();
      expect(lengths?.stored).not.toBe(Buffer.byteLength(original));
      const projected = projectModelContextEventSql(nativeFixtureEvent, sql.lit(0));
      const modelSizes = executeSqliteQueryTakeFirstSync(
        database,
        getNodeSqliteKysely<PayloadDatabase>(database)
          .selectFrom("transcript_events")
          .select((eb) => [
            transcriptEventModelBytesSql(sql.lit(0)).as("stored"),
            eb.fn<number>("octet_length", [projected]).as("native"),
          ]),
      );
      expect(modelSizes?.stored).toBe(modelSizes?.native);
    } finally {
      database.close();
    }
  });

  it.each(["native", "text fallback"])("preserves exact owner projections with %s JSON", (mode) => {
    const jsonb =
      mode === "text fallback"
        ? vi.spyOn(nodeSqlite, "supportsNodeSqliteJsonb").mockReturnValue(false)
        : undefined;
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const original = `{"type":"message","type":"reset","id":"first","id":"last","parentId":"parent","targetId":"target","appendParentId":"append","appendMode":"preserve","firstKeptEntryId":"kept","timestamp":"2026-01-01","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"large":"${"argument ".repeat(512)}"}}],"providerReplay":{"type":"checkpoint","data":"opaque"}},"message":{"role":"user","role":"toolResult","toolCallId":"call"}}`;
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

  it("admits model and retained-custom projections using exact costs without decoding bodies", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      createTable(database);
      const original = JSON.stringify({
        type: "message",
        id: "tool-result",
        data: "custom ".repeat(2048),
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "visible" }],
          details: { diagnostic: "detail ".repeat(2048) },
          __openclaw: { upstreamUserText: "upstream ".repeat(2048) },
          providerReplay: { type: "checkpoint", payload: "replay ".repeat(2048) },
        },
      });
      const prepared = prepareTranscriptPayload(database, original);
      expect(prepared.event_zstd).not.toBeNull();
      insert(database, 1, { ...prepared, event_zstd: Buffer.from([1, 2, 3]) });
      const db = getNodeSqliteKysely<PayloadDatabase>(database);
      const stored = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("transcript_events")
          .select([
            transcriptEventModelBytesSql(sql.lit(0)).as("model"),
            transcriptEventModelBytesSql(sql.lit(1)).as("withoutCheckpoint"),
            transcriptEventWithoutCustomDataBytesSql().as("withoutData"),
            transcriptEventModelNavigationSql().as("navigation"),
          ]),
      );
      const source = sql.val(original);
      const native = executeSqliteQueryTakeFirstSync(
        database,
        db.selectNoFrom((eb) => [
          eb
            .fn<number>("octet_length", [projectModelContextEventSql(source, sql.lit(0))])
            .as("model"),
          eb
            .fn<number>("octet_length", [projectModelContextEventSql(source, sql.lit(1))])
            .as("withoutCheckpoint"),
          eb
            .fn<number>("octet_length", [eb.fn<string>("json_remove", [source, eb.val("$.data")])])
            .as("withoutData"),
        ]),
      );
      expect(stored).toMatchObject(native!);
      expect(stored!.withoutCheckpoint).toBeLessThan(stored!.model);
      expect(stored!.model).toBeLessThan(Buffer.byteLength(original));
      expect(JSON.parse(stored!.navigation).message).toMatchObject({
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        isError: false,
      });
      expect(() => readBody(database, 1)).toThrow();
    } finally {
      database.close();
    }
  });

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
      }
      const withBom = Buffer.from('\ufeff{"type":"custom"}');
      insert(database, records.length, compressedRecord(withBom));
      expect(readBody(database, records.length)).toBe(withBom.toString("utf8"));
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
      expect(readBody(reader, 1)).toBe(original);
      expect(() => reader.prepare("SELECT * FROM decoded_payload").get()).toThrow();
    } finally {
      reader.close();
    }
  });
});
