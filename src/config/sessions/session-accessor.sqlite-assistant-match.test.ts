import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { findAssistantTranscriptEventInDatabase } from "./session-accessor.sqlite-read.js";
import type { SessionTranscriptEventMatch } from "./session-history-read.types.js";
import { findTranscriptEventMatchingInDatabase } from "./session-transcript-match.js";
import { prepareTranscriptPayload, type TranscriptPayloadRecord } from "./transcript-payload.js";
import { deriveTranscriptPredicateFields } from "./transcript-predicate-fields.js";

let db: DatabaseSync;
const sessionId = "assistant-match";

beforeAll(() => {
  db = openNodeSqliteDatabase(":memory:");
  // Legacy rows can predate identity indexing or contain invalid JSON.
  db.exec(`CREATE TABLE transcript_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, event_zstd BLOB,
      event_utf8_bytes INTEGER, navigation_json TEXT,
      navigation_type TEXT, navigation_custom_type TEXT, navigation_display INTEGER,
      message_role TEXT, navigation_last_type TEXT, navigation_last_custom_type TEXT,
      navigation_valid INTEGER, PRIMARY KEY (session_id, seq)
    ) STRICT;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY) STRICT`);
  admitSqliteSchema(db);
});
afterAll(() => db.close());
beforeEach(() => db.exec("DELETE FROM transcript_events"));

const insert = (seq: number, json: string, compress = false) => {
  const payload: TranscriptPayloadRecord = compress
    ? prepareTranscriptPayload(db, json)
    : {
        ...deriveTranscriptPredicateFields(json),
        event_json: json,
        event_zstd: null,
        event_utf8_bytes: Buffer.byteLength(json),
        navigation_json: null,
      };
  const row = { session_id: sessionId, seq, ...payload };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO transcript_events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
  return payload;
};

const find = (match: SessionTranscriptEventMatch) =>
  findTranscriptEventMatchingInDatabase(
    { db, path: ":memory:" },
    { target: { agentId: "main", sessionId }, match },
  );
const findBoth = (key: string) => [
  findAssistantTranscriptEventInDatabase({ db }, sessionId, key),
  find({ kind: "idempotency", key, assistant: true }),
];

const answer = {
  id: "answer",
  message: { role: "assistant", idempotencyKey: "wanted", content: "complete answer ".repeat(256) },
};
it("retains the last duplicate message envelope in a compressed JavaScript match", () => {
  const json = `{"id":"answer","message":{"role":"user","idempotencyKey":"other"},"message":${JSON.stringify(answer.message)}}`;
  expect(insert(0, json, true).event_zstd).not.toBeNull();
  expect(findBoth(answer.message.idempotencyKey)).toEqual([{ event: answer }, { event: answer }]);
  expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "other")).toBeUndefined();
  expect(find({ kind: "idempotency", key: "other" })).toBeUndefined();
});

it("decodes only selected compressed canonical candidates", () => {
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("Transcript matching regression requires native zstd support");
  }
  const event = {
    id: "old-answer",
    message: {
      ...answer.message,
      __openclaw: { runId: "wanted-run" },
      provider: "openclaw",
      model: "delivery-mirror",
    },
  };
  expect(insert(0, JSON.stringify(event), true).event_zstd).not.toBeNull();
  for (let seq = 1; seq <= 12; seq++) {
    const message = {
      ...event.message,
      role: seq % 2 ? "toolResult" : "assistant",
      idempotencyKey: "other",
      __openclaw: { runId: "other-run" },
    };
    insert(seq, JSON.stringify({ id: `unrelated-${seq}`, message }), true);
  }
  const decode = vi.spyOn(codec, "decompress");
  const sql = trackSqliteStatementExecutions(db, ["transcript"], (query) =>
    query.includes('from "transcript_events"') ? "transcript" : null,
  );
  try {
    for (const [match, expected] of [
      [{ kind: "visible-final", runId: "missing" }, undefined],
      [{ kind: "idempotency", key: "missing" }, undefined],
      [{ kind: "active-assistant", runId: "missing" }, undefined],
      [{ kind: "visible-final", runId: "wanted-run" }, { event }],
      [{ kind: "idempotency", key: "wanted", assistant: true, runId: "wanted-run" }, { event }],
      [{ kind: "idempotency", key: "wanted", deliveryMirror: true }, { event }],
      [{ kind: "latest" }, { event: { id: "unrelated-12" } }],
    ] satisfies [SessionTranscriptEventMatch, unknown][]) {
      decode.mockClear();
      sql.counts.transcript = 0;
      const found = find(match);
      expect(decode).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(sql.counts.transcript).toBe(expected && match.kind !== "latest" ? 2 : 1);
      if (match.kind === "latest") {
        expect(found).toMatchObject(expected);
      } else {
        expect(found).toEqual(expected);
      }
    }
  } finally {
    sql.restore();
    decode.mockRestore();
  }
});

it("skips malformed and non-object rows while retaining SQLite-overdepth JSON", () => {
  insert(
    0,
    `{"id":"deep","message":{"role":"assistant","idempotencyKey":"wanted","content":${"[".repeat(1001)}0${"]".repeat(1001)}}}`,
  );
  const malformed = ["null", "[]", '"text"', '{"message":', '{"message":null}'];
  for (const [index, value] of malformed.entries()) {
    insert(index + 1, value);
  }
  const expected = {
    event: { id: "deep", message: { role: "assistant", idempotencyKey: "wanted" } },
  };
  expect(findBoth("wanted")).toMatchObject([expected, expected]);
});
