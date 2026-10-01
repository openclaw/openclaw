import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { findAssistantTranscriptEventInDatabase } from "./session-accessor.sqlite-read.js";
import { prepareTranscriptPayload, type TranscriptPayloadRecord } from "./transcript-payload.js";

describe("persisted assistant transcript matching", () => {
  let db: DatabaseSync;
  const sessionId = "assistant-match";

  beforeAll(() => {
    db = openNodeSqliteDatabase(":memory:");
    // Raw legacy rows can predate identity indexing or contain invalid JSON.
    db.exec(`CREATE TABLE transcript_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, event_zstd BLOB,
      event_utf8_bytes INTEGER, navigation_json TEXT, PRIMARY KEY (session_id, seq)
    ) STRICT;
    CREATE TABLE session_transcript_cold_archives (session_id TEXT PRIMARY KEY) STRICT`);
  });
  afterAll(() => db.close());
  beforeEach(() => db.exec("DELETE FROM transcript_events"));

  const insert = (seq: number, json: string, compress = false) => {
    const payload: TranscriptPayloadRecord = compress
      ? prepareTranscriptPayload(db, json)
      : {
          event_json: json,
          event_zstd: null,
          event_utf8_bytes: Buffer.byteLength(json),
          navigation_json: null,
        };
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?)").run(
      sessionId,
      seq,
      payload.event_json,
      payload.event_zstd,
      payload.event_utf8_bytes,
      payload.navigation_json,
    );
    return payload;
  };

  it.each([
    {
      name: "duplicate root message envelopes",
      json: '{"id":"answer","message":{"role":"user","idempotencyKey":"other"},"message":{"role":"assistant","idempotencyKey":"wanted","content":"complete answer"}}',
    },
    {
      name: "duplicate nested roles and idempotency keys",
      json: '{"id":"answer","message":{"role":"user","role":"assistant","idempotencyKey":"other","idempotencyKey":"wanted","content":"complete answer"}}',
    },
    {
      name: "unindexed rows without an event type",
      json: '{"id":"answer","message":{"role":"assistant","idempotencyKey":"wanted","content":"complete answer"}}',
    },
  ])("retains JavaScript matching for $name", ({ json }) => {
    insert(0, json);
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "wanted")).toEqual({
      event: {
        id: "answer",
        message: { role: "assistant", idempotencyKey: "wanted", content: "complete answer" },
      },
    });
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "other")).toBeUndefined();
  });

  it("selects the last matching assistant despite newer user and duplicate-key collisions", () => {
    insert(0, '{"id":"older","message":{"role":"assistant","idempotencyKey":"wanted"}}');
    insert(
      1,
      '{"message":{"role":"assistant","idempotencyKey":"wanted","content":"legacy idless answer"}}',
    );
    insert(2, '{"id":"user","message":{"role":"user","idempotencyKey":"wanted"}}');
    insert(
      3,
      '{"message":{"role":"assistant","idempotencyKey":"wanted"},"message":{"role":"user","idempotencyKey":"wanted"}}',
    );
    insert(
      4,
      '{"message":{"role":"assistant","idempotencyKey":"wanted","idempotencyKey":"other"}}',
    );
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "wanted")).toEqual({
      event: {
        message: {
          role: "assistant",
          idempotencyKey: "wanted",
          content: "legacy idless answer",
        },
      },
    });
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId)).toEqual({
      event: { message: { role: "assistant", idempotencyKey: "other" } },
    });
  });

  it("skips malformed and non-object rows while retaining SQLite-overdepth JSON", () => {
    insert(
      0,
      `{"id":"deep","message":{"role":"assistant","idempotencyKey":"wanted","content":${"[".repeat(1001)}0${"]".repeat(1001)}}}`,
    );
    for (const [index, value] of [
      "null",
      "[]",
      '"text"',
      '{"message":',
      '{"message":null}',
    ].entries()) {
      insert(index + 1, value);
    }
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "wanted")).toMatchObject({
      event: { id: "deep", message: { role: "assistant", idempotencyKey: "wanted" } },
    });
  });

  it.each(["a\u0000b", "\ud800", "雪🦞"])("matches exact persisted Unicode identity %j", (key) => {
    insert(
      0,
      JSON.stringify({ message: { role: "assistant", idempotencyKey: key, content: "answer" } }),
    );
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, key)).toEqual({
      event: { message: { role: "assistant", idempotencyKey: key, content: "answer" } },
    });
  });

  it("hydrates the complete matching compressed payload", () => {
    const content = "compressed answer ".repeat(256);
    const event = {
      id: "compressed",
      message: { role: "assistant", idempotencyKey: "wanted", content },
    };
    const payload = insert(0, JSON.stringify(event), true);
    expect(payload.event_zstd).not.toBeNull();
    expect(findAssistantTranscriptEventInDatabase({ db }, sessionId, "wanted")).toEqual({ event });
  });
});
