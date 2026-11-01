import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { assertNoActiveSqliteReaders } from "../../infra/sqlite-reader-lifecycle.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import * as readonlyStore from "../../state/openclaw-agent-db-readonly.js";
import { streamSessionTranscriptHydration } from "./session-transcript-hydration.worker.js";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-worker.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(
  rows: Array<{ seq: number; text?: string; compressed?: Uint8Array; size?: number }>,
) {
  const pathname = path.join(tempDirs.make("hydration-pages-"), "transcript.sqlite");
  const writer = openNodeSqliteDatabase(pathname);
  // Minimal physical schema permits corrupt records and unusual sequence values.
  writer.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT,
      event_zstd BLOB, event_utf8_bytes INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE session_transcript_cold_archives (session_id TEXT, last_seq INTEGER);
    CREATE TABLE transcript_rewrite_watermarks (session_id TEXT, generation TEXT);
    CREATE TABLE session_windows (session_id TEXT, transcript_updated_at INTEGER);
    INSERT INTO transcript_rewrite_watermarks VALUES ('fixture', 'original');
    INSERT INTO session_windows VALUES ('fixture', 7);`);
  const insert = writer.prepare("INSERT INTO transcript_events VALUES ('fixture', ?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(row.seq, row.text ?? null, row.compressed ?? null, row.size ?? null);
  }
  const reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  admitSqliteSchema(reader);
  const transactionsAtClose: boolean[] = [];
  vi.spyOn(readonlyStore, "openOpenClawAgentDatabaseReadOnly").mockReturnValue({
    found: true,
    database: {
      agentId: "main",
      path: pathname,
      db: reader,
      close() {
        transactionsAtClose.push(reader.isTransaction);
        assertNoActiveSqliteReaders(reader, "hydration cleanup");
        reader.close();
      },
    },
  });
  const controller = new AbortController();
  const chunks: SessionTranscriptHydrationChunk[] = [];
  const stream = (
    onChunk?: (chunk: SessionTranscriptHydrationChunk) => Promise<void>,
    afterSeq?: number,
  ) =>
    streamSessionTranscriptHydration(
      {
        kind: "transcript-hydration",
        database: { agentId: "main", path: pathname },
        resolvedScope: { agentId: "main", sessionId: "fixture", path: pathname },
        target: { sessionId: "fixture" },
        includeEventJson: true,
        afterSeq,
      },
      {
        consumeInput() {},
        notify() {},
        async request(value, transferList) {
          const chunk = structuredClone(value, {
            transfer: transferList?.slice(),
          }) as SessionTranscriptHydrationChunk;
          chunks.push(chunk);
          await onChunk?.(chunk);
          return { input: undefined, consumed() {} };
        },
      },
      {
        runNativeSection: async (operation) => operation(),
        throwIfCancelled: () => controller.signal.throwIfAborted(),
      },
    );
  return {
    writer,
    reader,
    chunks,
    controller,
    transactionsAtClose,
    stream,
    frames: () => chunks.flatMap((chunk) => chunk.frames),
    [Symbol.dispose]: () => writer.close(),
  };
}

it("keeps exact bytes across bounded UTF-8 and compressed frames", async () => {
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("The hydration regression requires zstd support");
  }
  const texts = Array.from({ length: 270 }, (_, index) => JSON.stringify({ id: index }));
  // Split a multibyte code point and terminate exact slice multiples with an empty frame.
  texts[0] = `${" ".repeat(65535)}"🦞"`;
  texts[1] = "{}".padEnd(2 * 65536, " ");
  texts[257] = "{}".padEnd(20 * 65536, " ");
  using f = fixture(
    texts.map((text, seq) =>
      seq === 257
        ? {
            seq,
            compressed: codec.compress(Buffer.from(text), 1, true),
            size: Buffer.byteLength(text),
          }
        : { seq: seq === 0 ? -2 : seq, text },
    ),
  );
  const decompress = vi.spyOn(codec, "decompress");
  const result = await f.stream();
  expect(result).toEqual({
    kind: "full",
    eventCount: texts.length,
    version: { generation: "original", rawSeq: 269, updatedAt: 7 },
  });
  const events: Buffer[] = [];
  const sequences: Array<number | undefined> = [];
  let parts: Uint8Array[] = [];
  for (const chunk of f.chunks) {
    expect(chunk.encoding).toBe("UTF-8");
    expect(chunk.frames.length).toBeLessThanOrEqual(128);
    expect(chunk.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0)).toBeLessThanOrEqual(
      1024 * 1024,
    );
    for (const frame of chunk.frames) {
      expect(frame.data.byteLength).toBeLessThanOrEqual(65536);
      parts.push(frame.data);
      if (frame.endOfEvent) {
        sequences.push(frame.seq);
        events.push(Buffer.concat(parts));
        parts = [];
      }
    }
  }
  expect(parts).toEqual([]);
  expect(events).toEqual(texts.map((text) => Buffer.from(text)));
  expect(sequences).toEqual(texts.map((_, index) => (index === 0 ? -2 : index)));
  expect(
    f
      .frames()
      .filter((frame) => frame.endOfEvent && frame.data.byteLength === 0)
      .map((frame) => frame.seq),
  ).toEqual([1, 257]);
  expect(f).toMatchObject({ transactionsAtClose: [false], reader: { isOpen: false } });
  expect(decompress).toHaveBeenCalledTimes(1);
});

it.each(["cancel", "host-error"] as const)(
  "closes the snapshot after %s without decoding unread payloads",
  async (failure) => {
    using f = fixture([
      ...Array.from({ length: 128 }, (_, seq) => ({ seq, text: "{}" })),
      { seq: 128, compressed: new Uint8Array([0]), size: 1 },
    ]);
    const error = new Error(failure);
    await expect(
      f.stream(async () => {
        expect(f.reader.isTransaction).toBe(true);
        if (failure === "cancel") {
          f.controller.abort(error);
        } else {
          throw error;
        }
      }),
    ).rejects.toBe(error);
    expect(f.chunks).toHaveLength(1);
    expect(f).toMatchObject({ transactionsAtClose: [false], reader: { isOpen: false } });
  },
);

it("keeps empty events and applies a negative sequence fence before decoding", async () => {
  using f = fixture([
    { seq: -4, compressed: new Uint8Array([0]), size: 1 },
    { seq: -3, text: "excluded" },
    { seq: -2, text: "" },
    { seq: 0, text: '{"id":"selected"}' },
  ]);
  await expect(f.stream(undefined, -3)).resolves.toMatchObject({ eventCount: 2 });
  const frames = f.frames();
  expect(frames.map((frame) => frame.seq)).toEqual([-2, 0]);
  expect(frames[0]).toEqual({ data: new Uint8Array(), endOfEvent: true, seq: -2 });
  expect(f.transactionsAtClose).toEqual([false]);
});
