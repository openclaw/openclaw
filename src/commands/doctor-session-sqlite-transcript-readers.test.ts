import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";

let database: ReturnType<typeof openNodeSqliteDatabase>;
const accept = () => true;
beforeEach(() => {
  database = openNodeSqliteDatabase(":memory:");
});
afterEach(() => database.close());
function tables(table = "transcript_events", extraColumns = "") {
  database.exec(`
        CREATE TABLE ${table} (
          session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT ${extraColumns}
        );
        CREATE TABLE session_windows (session_id TEXT${table === "source_rows" ? " PRIMARY KEY" : ""}, session_key TEXT);
      `);
}
type StoredPayload = string | Uint8Array | null;
function seed(sessionId: string, events: StoredPayload[], table = "transcript_events") {
  database
    .prepare("INSERT INTO session_windows VALUES (?, ?)")
    .run(sessionId, `agent:main:${sessionId}`);
  const insert = database.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
  events.forEach((eventJson, seq) => insert.run(sessionId, seq, 20 + seq, eventJson));
}
function snapshot(events: string[], headerSession?: string, firstSeq = 0) {
  return {
    ok: true,
    rows: events.map((eventJson, seq) => ({
      eventJson,
      seq: seq + firstSeq,
      ...(headerSession ? { createdAt: 20 + seq } : {}),
    })),
    ...(headerSession ? { sessionKey: `agent:main:${headerSession}` } : {}),
  };
}

it.each([false, true])("detects headerless sessions (compressed: %s)", (compressed) => {
  tables();
  const originals = [
    ` { "type": "message", "id": "first", "message": {"role":"user","content":"${"🦞".repeat(500)}"} } `,
    `{"type":"message","id":"second","message":{"role":"assistant","content":"${"kept".repeat(500)}"}}`,
    `{"type":"message","id":"tool","message":{"role":"toolResult","content":"${"tool output".repeat(200)}"}}`,
  ];
  for (const [sessionId, events] of [
    ["candidate", originals],
    ["\uE000", ['{"type":"session","type":"message"}']],
    ["healthy", ['{"type":"message","type":"session"}']],
    ["invalid", [compressed ? new Uint8Array([123]) : null]],
    ["malformed", ["{", originals[0]!]],
    ["\u{10000}", [originals[0]!]],
  ] as const) {
    seed(sessionId, [...events]);
  }
  database.exec("UPDATE transcript_events SET seq = seq + 7");
  if (compressed) {
    database.exec(
      "ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB; ALTER TABLE transcript_events ADD COLUMN event_utf8_bytes INTEGER; ALTER TABLE transcript_events ADD COLUMN navigation_json TEXT",
    );
    for (const eventJson of originals) {
      const payload = prepareTranscriptPayload(database, eventJson, undefined, "UTF-8");
      expect(payload.event_zstd).toBeInstanceOf(Uint8Array);
      database
        .prepare(
          "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE event_json = ?",
        )
        .run(payload.event_zstd, payload.event_utf8_bytes, payload.navigation_json, eventJson);
    }
  }
  const reader = new ReadOnlySqliteTranscriptReader(database);
  const errors: string[] = [];
  const candidates = () => reader.headerlessSessionIds((sessionId) => errors.push(sessionId));
  expect(candidates()).toEqual(["candidate", "invalid", "\uE000", "\u{10000}"]);
  expect(errors).toEqual([]);
  expect(reader.headerlessSnapshot("invalid", accept)).toMatchObject({ ok: false });
  expect(reader.labelRepairSnapshot("candidate", accept, accept)).toEqual(
    snapshot(originals, undefined, 7),
  );
  expect(reader.headerlessSnapshot("candidate", accept)).toEqual(
    snapshot(originals, "candidate", 7),
  );
  if (compressed) {
    database
      .prepare("UPDATE transcript_events SET event_zstd = ? WHERE session_id = ? AND seq = 7")
      .run(new Uint8Array([0]), "candidate");
    expect(candidates()).toEqual(["invalid", "\uE000", "\u{10000}"]);
    expect(errors).toEqual(["candidate"]);
    expect(reader.labelRepairSnapshot("candidate", accept, accept)).toMatchObject({ ok: false });
  }
});

it("closes a rejected header snapshot before the next database operation", () => {
  tables();
  seed("rejected", ['{"type":"message","id":"first"}', '{"type":"session","id":"rejected"}']);
  const reader = new ReadOnlySqliteTranscriptReader(database);
  expect(reader.headerlessSnapshot("rejected", () => false)).toEqual({ ok: true, rows: [] });
  // A live native cursor would keep this schema write locked.
  expect(() => database.exec("DROP TABLE transcript_events")).not.toThrow();
});

it.each([
  { stage: "label detection", header: false, failingSeq: 0 },
  { stage: "nested label snapshot", header: false, failingSeq: 1 },
  { stage: "header snapshot", header: true, failingSeq: 1 },
])("isolates a $stage step failure from the next session", ({ header, failingSeq }) => {
  // json() fails during native stepping. The primary key lets the first row
  // reach detection before a later row fails in the complete snapshot.
  tables("source_rows", ", PRIMARY KEY (session_id, seq)");
  database.exec(`
        CREATE VIEW transcript_events AS
          SELECT session_id, seq, created_at, json(event_json) AS event_json FROM source_rows;
      `);
  seed(
    "broken",
    [...(failingSeq === 1 ? ['{"type":"message","id":"first"}'] : []), "{"],
    "source_rows",
  );
  const healthyEvents = [
    '{"type":"message","id":"healthy-first"}',
    '{"type":"message","id":"healthy-second"}',
  ];
  seed("healthy", healthyEvents, "source_rows");

  const reader = new ReadOnlySqliteTranscriptReader(database);
  const read = (sessionId: string) =>
    header
      ? reader.headerlessSnapshot(sessionId, accept)
      : reader.labelRepairSnapshot(sessionId, accept, accept);
  expect(read("broken")).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/malformed JSON/iu) },
  });
  expect(read("healthy")).toEqual(snapshot(healthyEvents, header ? "healthy" : undefined));
});
