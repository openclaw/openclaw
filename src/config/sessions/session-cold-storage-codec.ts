import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { z } from "zod";
import { resolveSessionArtifactDirectory } from "./paths.js";
import { readTranscriptArchiveRecords } from "./session-accessor.sqlite-archive-stream.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";

export const MAX_SESSION_COLD_ARCHIVE_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES =
  MAX_SESSION_COLD_ARCHIVE_DECODED_BYTES + 1024 * 1024;

export function resolveSessionColdArchivePath(storePath: string, archiveName: string): string {
  if (!/^[a-f0-9]{64}\.jsonl\.zst$/.test(archiveName)) {
    throw new Error("Invalid cold transcript archive name");
  }
  return path.join(resolveSessionArtifactDirectory(storePath), "cold", archiveName);
}

export async function readVerifiedSessionColdArchive(params: {
  storePath: string;
  archive: {
    archive_name: string;
    archive_sha256: string;
    archive_bytes: number;
    storage: string;
    archive_blob: Uint8Array | null;
  };
}): Promise<Buffer> {
  const { archive } = params;
  if (
    !Number.isSafeInteger(archive.archive_bytes) ||
    archive.archive_bytes < 0 ||
    archive.archive_bytes > MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES
  ) {
    throw new Error(
      `Cold transcript archive ${archive.archive_name} exceeds the bounded read size`,
    );
  }
  let bytes: Buffer;
  if (archive.storage === "sqlite") {
    if (archive.archive_blob?.byteLength !== archive.archive_bytes) {
      throw new Error(`Cold transcript archive ${archive.archive_name} has an invalid stored size`);
    }
    bytes = Buffer.from(archive.archive_blob);
  } else {
    const archivePath = resolveSessionColdArchivePath(params.storePath, archive.archive_name);
    const invalidSize = new Error(
      `Cold transcript archive ${archive.archive_name} failed verification. Restore it from a verified backup.`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(archivePath, "r");
      const stat = await handle.stat();
      if (
        stat.size !== archive.archive_bytes ||
        stat.size > MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES
      ) {
        throw invalidSize;
      }
      bytes = Buffer.allocUnsafe(archive.archive_bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
          throw invalidSize;
        }
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead > 0) {
        throw invalidSize;
      }
      const current = await handle.stat();
      if (
        stat.dev !== current.dev ||
        stat.ino !== current.ino ||
        stat.size !== current.size ||
        stat.mtimeMs !== current.mtimeMs ||
        stat.ctimeMs !== current.ctimeMs
      ) {
        throw invalidSize;
      }
    } catch (error) {
      if (error === invalidSize) {
        throw error;
      }
      throw new Error(
        `Cold transcript archive ${archive.archive_name} is missing or unreadable. Restore it from a backup; its transcript has not been replaced with empty history.`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  if (
    bytes.length !== archive.archive_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== archive.archive_sha256
  ) {
    throw new Error(
      `Cold transcript archive ${archive.archive_name} failed verification. Restore it from a verified backup.`,
    );
  }
  return bytes;
}

/** Visit canonical event JSON without materializing the cold transcript's full record array. */
export async function forEachVerifiedSessionColdArchiveEvent(params: {
  storePath: string;
  archive: SessionColdArchive;
  visitEventJson: (eventJson: string) => void;
}): Promise<void> {
  if (params.archive.archive_bytes > MAX_SESSION_COLD_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error("Cold transcript archive exceeds the supported bounded read size");
  }
  const bytes = await readVerifiedSessionColdArchive(params);
  // SAFETY: Node versions without the optional zstd API are rejected before invocation.
  const createZstdDecompress = (zlib as Partial<typeof zlib>).createZstdDecompress;
  if (!createZstdDecompress) {
    throw new Error("Cannot decode compressed transcript archive: this runtime lacks zstd support");
  }
  let decodedBytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.byteLength;
      callback(
        decodedBytes > MAX_SESSION_COLD_ARCHIVE_DECODED_BYTES
          ? new Error("Cold transcript archive exceeds the supported decoded size")
          : null,
        chunk,
      );
    },
  });
  const source = Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    })(),
  );
  const completed = pipeline(source, createZstdDecompress.call(zlib), bounded);
  let header: z.infer<typeof sessionColdRecordSchema> | undefined;
  let eventCount = 0;
  let rawBytes = 0;
  let lastSeq: number | undefined;
  try {
    for await (const line of readTranscriptArchiveRecords(
      bounded,
      MAX_SESSION_COLD_ARCHIVE_DECODED_BYTES,
    )) {
      const record = sessionColdRecordSchema.parse(JSON.parse(line.toString("utf8")));
      if (!header) {
        if (record.kind !== "header") {
          throw new Error("Cold transcript archive is missing its header");
        }
        header = record;
        continue;
      }
      if (record.kind === "header") {
        throw new Error("Cold transcript archive contains more than one header");
      }
      if (record.kind === "event") {
        JSON.parse(record.row.event_json);
        params.visitEventJson(record.row.event_json);
        eventCount++;
        lastSeq = record.row.seq;
        rawBytes += Buffer.byteLength(record.row.event_json);
      }
    }
    await completed;
  } catch (error) {
    source.destroy();
    bounded.destroy();
    await completed.catch(() => undefined);
    throw error;
  }
  const expected = params.archive;
  if (
    header?.kind !== "header" ||
    header.sessionId !== expected.session_id ||
    header.generation !== expected.generation ||
    eventCount !== expected.event_count ||
    lastSeq !== expected.last_seq ||
    rawBytes + eventCount - 1 !== expected.raw_bytes
  ) {
    throw new Error("Cold transcript archive metadata does not match its contents");
  }
}

const integer = z.number().int();
const nullableString = z.string().nullable();
export const sessionColdRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("header"),
    version: z.literal(1),
    sessionId: z.string(),
    generation: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    row: z.object({ seq: integer, event_json: z.string(), created_at: integer }),
  }),
  z.object({
    kind: z.literal("identity"),
    row: z.object({
      event_id: z.string(),
      seq: integer,
      event_type: nullableString,
      parent_id: nullableString,
      message_idempotency_key: nullableString,
      created_at: integer,
    }),
  }),
  z.object({
    kind: z.literal("active"),
    row: z.object({
      active_position: integer,
      event_seq: integer,
      message_position: integer.nullable(),
      context_eligible: integer.nullable(),
    }),
  }),
  z.object({
    kind: z.literal("index"),
    row: z.object({
      indexed_seq: integer,
      leaf_event_id: nullableString,
      needs_rebuild: integer,
      active_event_count: integer,
      active_message_count: integer,
      updated_at: integer,
    }),
  }),
  z.object({
    kind: z.literal("fts"),
    row: z.object({
      text: nullableString,
      message_id: nullableString,
      role: nullableString,
      timestamp: z.union([z.string(), z.number()]).nullable(),
    }),
  }),
]);
export type SessionColdRecord = z.infer<typeof sessionColdRecordSchema>;
