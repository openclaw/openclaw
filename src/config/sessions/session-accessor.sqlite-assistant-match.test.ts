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

  const answer = {
    id: "answer",
    message: { role: "assistant", idempotencyKey: "wanted", content: "complete answer" },
  };
  const encodedCases = [
    { key: "a\u0000b", content: "answer", compress: false },
    { key: "\ud800", content: "answer", compress: false },
    { key: "wanted", content: "compressed answer ".repeat(256), compress: true },
  ].map(({ key, content, compress }) => {
    const message = { role: "assistant", idempotencyKey: key, content };
    const event = compress ? { id: "compressed", message } : { message };
    return {
      name: compress ? "compressed payload" : `Unicode ${JSON.stringify(key)}`,
      json: JSON.stringify(event),
      event,
      compress,
    };
  });
  it.each([
    {
      name: "duplicate root message envelopes",
      json: '{"id":"answer","message":{"role":"user","idempotencyKey":"other"},"message":{"role":"assistant","idempotencyKey":"wanted","content":"complete answer"}}',
      event: answer,
      compress: false,
    },
    {
      name: "duplicate nested roles and idempotency keys",
      json: '{"id":"answer","message":{"role":"user","role":"assistant","idempotencyKey":"other","idempotencyKey":"wanted","content":"complete answer"}}',
      event: answer,
      compress: false,
    },
    ...encodedCases,
  ])("retains complete JavaScript matches for $name", ({ json, event, compress }) => {
    const payload = insert(0, json, compress);
    if (compress) {
      expect(payload.event_zstd).not.toBeNull();
    }
    expect(
      findAssistantTranscriptEventInDatabase({ db }, sessionId, event.message.idempotencyKey),
    ).toEqual({ event });
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
});
