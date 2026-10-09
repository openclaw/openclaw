import path from "node:path";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
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
        reader.close();
      },
    },
  });
  const controller = new AbortController();
  const control: WorkerTaskControl = {
    runNativeSection: async (operation) => operation(),
    throwIfCancelled: () => controller.signal.throwIfAborted(),
  };
  const chunks: SessionTranscriptHydrationChunk[] = [];
  const channel = (
    onChunk?: (chunk: SessionTranscriptHydrationChunk) => Promise<void>,
  ): WorkerTaskChannel => ({
    consumeInput() {},
    notify() {},
    async request(value) {
      const chunk = value as SessionTranscriptHydrationChunk;
      chunks.push(chunk);
      await onChunk?.(chunk);
      return { input: undefined, consumed() {} };
    },
  });
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
      channel(onChunk),
      control,
    );
  return { writer, reader, chunks, controller, transactionsAtClose, stream };
}

it("keeps exact bytes and one snapshot across ACKs and keyset pages", async () => {
  const codec = resolveZstdCodec();
  if (!codec) {
    throw new Error("The hydration regression requires zstd support");
  }
  const texts = Array.from({ length: 270 }, (_, index) => JSON.stringify({ id: index }));
  // Split a multibyte code point and terminate exact slice multiples with an empty frame.
  texts[0] = `${" ".repeat(65535)}"🦞"`;
  texts[1] = "{}".padEnd(2 * 65536, " ");
  texts[257] = "{}".padEnd(4 * 65536, " ");
  const f = fixture(
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
  let acknowledgements = 0;
  try {
    const result = await f.stream(async () => {
      expect(f.reader.isTransaction).toBe(true);
      if (acknowledgements++ === 0) {
        f.writer
          .prepare("UPDATE transcript_events SET event_json = 'changed' WHERE seq = 260")
          .run();
        f.writer
          .prepare("INSERT INTO transcript_events VALUES ('fixture', 270, 'new', NULL, NULL)")
          .run();
      }
      await Promise.resolve();
    });
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
      expect(
        chunk.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0),
      ).toBeLessThanOrEqual(1024 * 1024);
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
      f.chunks
        .flatMap((chunk) => chunk.frames)
        .filter((frame) => frame.endOfEvent && frame.data.byteLength === 0)
        .map((frame) => frame.seq),
    ).toEqual([1, 257]);
    expect(f.transactionsAtClose).toEqual([false]);
    expect(f.reader.isOpen).toBe(false);
  } finally {
    f.writer.close();
  }
});

it.each(["cancel", "host-error"] as const)(
  "closes the snapshot after %s before reading the next payload page",
  async (failure) => {
    const f = fixture([
      ...Array.from({ length: 256 }, (_, seq) => ({ seq, text: "{}" })),
      { seq: 256, compressed: new Uint8Array([0]), size: 1 },
    ]);
    const error = new Error(failure);
    try {
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
      expect(f.transactionsAtClose).toEqual([false]);
      expect(f.reader.isOpen).toBe(false);
    } finally {
      f.writer.close();
    }
  },
);

it("keeps empty events and applies a negative sequence fence before decoding", async () => {
  const f = fixture([
    { seq: -4, compressed: new Uint8Array([0]), size: 1 },
    { seq: -3, text: "excluded" },
    { seq: -2, text: "" },
    { seq: 0, text: '{"id":"selected"}' },
  ]);
  try {
    await expect(f.stream(undefined, -3)).resolves.toMatchObject({ eventCount: 2 });
    const frames = f.chunks.flatMap((chunk) => chunk.frames);
    expect(frames.map((frame) => frame.seq)).toEqual([-2, 0]);
    expect(frames[0]).toEqual({ data: new Uint8Array(), endOfEvent: true, seq: -2 });
    expect(f.transactionsAtClose).toEqual([false]);
  } finally {
    f.writer.close();
  }
});
