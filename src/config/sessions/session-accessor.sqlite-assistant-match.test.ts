import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { findAssistantTranscriptEventInDatabase } from "./session-accessor.sqlite-read.js";
import type { SessionTranscriptEventMatch } from "./session-history-read.types.js";
import { findTranscriptEventMatchingInDatabase } from "./session-transcript-match.js";
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

  const find = (match: SessionTranscriptEventMatch) =>
    findTranscriptEventMatchingInDatabase(
      { db, path: ":memory:" },
      { target: { agentId: "main", sessionId }, match },
    );

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
  const duplicateCases = [
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
  ];
  it.each([
    ...duplicateCases,
    ...duplicateCases.map((entry) => ({
      name: `compressed ${entry.name}`,
      compress: true,
      json: entry.json.replace("complete answer", "complete answer ".repeat(256)),
      event: { ...answer, message: { ...answer.message, content: "complete answer ".repeat(256) } },
    })),
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
    expect(
      find({ kind: "idempotency", key: event.message.idempotencyKey, assistant: true }),
    ).toEqual({ event });
    expect(find({ kind: "idempotency", key: "other" })).toBeUndefined();
  });

  it.each([false, true])(
    "decodes only selected canonical candidates (compressed: %s)",
    (compress) => {
      const codec = resolveZstdCodec();
      if (!codec) {
        throw new Error("Transcript matching regression requires native zstd support");
      }
      const event = {
        id: "old-answer",
        message: {
          role: "assistant",
          idempotencyKey: "wanted",
          __openclaw: { runId: "wanted-run" },
          content: "complete answer ".repeat(256),
          provider: "openclaw",
          model: "delivery-mirror",
        },
      };
      expect(insert(0, JSON.stringify(event), compress).event_zstd !== null).toBe(compress);
      for (let seq = 1; seq <= 12; seq++) {
        insert(
          seq,
          JSON.stringify({
            ...event,
            id: `unrelated-${seq}`,
            message: {
              ...event.message,
              role: seq % 2 ? "toolResult" : "assistant",
              idempotencyKey: "other",
              __openclaw: { runId: "other-run" },
            },
          }),
          compress,
        );
      }
      const decode = vi.spyOn(codec, "decompress");
      const sql = trackSqliteStatementExecutions(db, ["transcript"], (query) =>
        query.includes('from "transcript_events"') ? "transcript" : null,
      );
      try {
        for (const match of [
          { kind: "visible-final", runId: "missing" },
          { kind: "idempotency", key: "missing" },
          { kind: "active-assistant", runId: "missing" },
        ] satisfies SessionTranscriptEventMatch[]) {
          decode.mockClear();
          sql.counts.transcript = 0;
          expect(find(match)).toBeUndefined();
          expect(decode).not.toHaveBeenCalled();
          expect(sql.counts.transcript).toBe(1);
        }
        for (const match of [
          { kind: "visible-final", runId: "wanted-run" },
          { kind: "idempotency", key: "wanted", assistant: true, runId: "wanted-run" },
          { kind: "idempotency", key: "wanted", deliveryMirror: true },
        ] satisfies SessionTranscriptEventMatch[]) {
          decode.mockClear();
          sql.counts.transcript = 0;
          expect(find(match)).toEqual({ event });
          expect(decode).toHaveBeenCalledTimes(compress ? 1 : 0);
          expect(sql.counts.transcript).toBe(compress ? 2 : 1);
        }
        decode.mockClear();
        sql.counts.transcript = 0;
        expect(find({ kind: "latest" })).toMatchObject({ event: { id: "unrelated-12" } });
        expect(decode).toHaveBeenCalledTimes(compress ? 1 : 0);
        expect(sql.counts.transcript).toBe(1);
      } finally {
        sql.restore();
        decode.mockRestore();
      }
    },
  );

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
    expect(find({ kind: "idempotency", key: "wanted", assistant: true })).toMatchObject({
      event: { id: "deep", message: { role: "assistant", idempotencyKey: "wanted" } },
    });
  });
});
