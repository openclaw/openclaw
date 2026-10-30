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
        CREATE TABLE ${table} (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT ${extraColumns});
        CREATE TABLE session_windows (session_id TEXT${table === "source_rows" ? " PRIMARY KEY" : ""}, session_key TEXT);
      `);
}
function seed(sessionId: string, events: (string | null)[], table = "transcript_events") {
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

it("selects legacy headerless sessions by first sequence and full JSON semantics", () => {
  tables();
  const event = '{"type":"message"}';
  for (const [id, events] of [
    ["candidate", [event]],
    ["\uE000", ['{"type":"session","type":"message"}']],
    ["healthy", ['{"type":"message","type":"session"}']],
    ["invalid", [null]],
    ["malformed", ["{", event]],
    ["\u{10000}", [event]],
  ] as const) {
    seed(id, [...events]);
  }
  database.exec("UPDATE transcript_events SET seq = seq + 7");
  const reader = new ReadOnlySqliteTranscriptReader(database);
  expect(reader.headerlessSessionIds(() => {})).toEqual([
    "candidate",
    "invalid",
    "\uE000",
    "\u{10000}",
  ]);
  expect(reader.headerlessSnapshot("invalid", accept)).toMatchObject({ ok: false });
  expect(reader.headerlessSnapshot("candidate", accept)).toEqual(snapshot([event], "candidate", 7));
});

it("preserves exact compressed payloads in label and header repair snapshots", () => {
  tables("transcript_events", ", event_zstd BLOB, event_utf8_bytes INTEGER, navigation_json TEXT");
  database.exec("INSERT INTO session_windows VALUES ('compressed', 'agent:main:compressed')");
  const originals = [
    ` { "type": "message", "id": "first", "message": {"role":"user","content":"${"🦞".repeat(500)}"} } `,
    `{"type":"message","id":"second","message":{"role":"assistant","content":"${"kept".repeat(500)}"}}`,
    `{"type":"message","id":"tool","message":{"role":"toolResult","content":"${"tool output".repeat(200)}"}}`,
  ];
  const insert = database.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, NULL, ?, ?, ?)");
  for (const [seq, eventJson] of originals.entries()) {
    const { event_zstd, event_utf8_bytes, navigation_json } = prepareTranscriptPayload(
      database,
      eventJson,
      undefined,
      "UTF-8",
    );
    expect(event_zstd).toBeInstanceOf(Uint8Array);
    insert.run("compressed", seq, 20 + seq, event_zstd, event_utf8_bytes, navigation_json);
  }
  const reader = new ReadOnlySqliteTranscriptReader(database);
  expect(reader.headerlessSessionIds(() => {})).toEqual(["compressed"]);
  expect(reader.labelRepairSnapshot("compressed", accept, accept)).toEqual(snapshot(originals));
  expect(reader.headerlessSnapshot("compressed", accept)).toEqual(
    snapshot(originals, "compressed"),
  );
  database
    .prepare("UPDATE transcript_events SET event_zstd = ? WHERE session_id = ? AND seq = 2")
    .run(new Uint8Array([0]), "compressed");
  expect(reader.labelRepairSnapshot("compressed", accept, accept)).toMatchObject({ ok: false });
  database
    .prepare("UPDATE transcript_events SET event_zstd = ? WHERE seq = 0")
    .run(new Uint8Array([0]));
  const errors: string[] = [];
  expect(reader.headerlessSessionIds((id) => errors.push(id))).toEqual([]);
  expect(errors).toEqual(["compressed"]);
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
