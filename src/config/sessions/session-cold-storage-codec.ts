import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import { resolveSessionArtifactDirectory } from "./paths.js";
import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";

export const MAX_COLD_ARCHIVE_BYTES = 64 * 1024 * 1024;

type SessionColdFile = Pick<
  SessionColdArchive,
  "archive_name" | "archive_sha256" | "archive_bytes" | "storage" | "archive_blob"
>;

function verifySessionColdArchiveBytes(bytes: Buffer, archive: SessionColdFile): Buffer {
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

function missingSessionColdArchive(archiveName: string, cause: unknown): Error {
  return new Error(
    `Cold transcript archive ${archiveName} is missing or unreadable. Restore it from a backup; its transcript has not been replaced with empty history.`,
    { cause },
  );
}

export function resolveSessionColdArchivePath(storePath: string, archiveName: string): string {
  if (!/^[a-f0-9]{64}\.jsonl\.zst$/.test(archiveName)) {
    throw new Error("Invalid cold transcript archive name");
  }
  return path.join(resolveSessionArtifactDirectory(storePath), "cold", archiveName);
}

export async function readVerifiedSessionColdArchive(params: {
  storePath: string;
  archive: SessionColdFile;
}): Promise<Buffer> {
  const { archive } = params;
  const bytes =
    archive.storage === "sqlite"
      ? Buffer.from(archive.archive_blob ?? [])
      : await fs
          .readFile(resolveSessionColdArchivePath(params.storePath, archive.archive_name))
          .catch((error: unknown) => {
            throw missingSessionColdArchive(archive.archive_name, error);
          });
  return verifySessionColdArchiveBytes(bytes, archive);
}

/** The restoration transaction consumes one immutable file or embedded chunk at a time. */
export function readVerifiedSessionColdArchiveSync(params: {
  storePath: string;
  archive: SessionColdFile;
}): Buffer {
  const { archive } = params;
  if (archive.storage === "sqlite") {
    return verifySessionColdArchiveBytes(Buffer.from(archive.archive_blob ?? []), archive);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolveSessionColdArchivePath(params.storePath, archive.archive_name));
  } catch (error) {
    throw missingSessionColdArchive(archive.archive_name, error);
  }
  return verifySessionColdArchiveBytes(bytes, archive);
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

export function verifyPublishedSessionColdArchive(
  storePath: string,
  archive: Pick<SessionColdArchive, "archive_name" | "archive_sha256" | "archive_bytes">,
): void {
  const published = readFileSync(resolveSessionColdArchivePath(storePath, archive.archive_name));
  if (
    published.length !== archive.archive_bytes ||
    createHash("sha256").update(published).digest("hex") !== archive.archive_sha256
  ) {
    throw new Error("Cold archive changed before publication; its SQLite copy was retained");
  }
}

/** Exhaust before publication, or consume inside a transaction that rolls back on failure. */
export function* decodeSessionColdRecords(
  bytes: Uint8Array,
  archive: Pick<
    SessionColdArchive,
    "session_id" | "generation" | "event_count" | "raw_bytes" | "last_seq"
  > & { first_seq?: number },
): Generator<SessionColdRecord> {
  const decoded = zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_COLD_ARCHIVE_BYTES });
  let headerSeen = false;
  let eventCount = 0;
  let rawBytes = -1;
  let lastSeq: number | undefined;
  for (let offset = 0; offset < decoded.length;) {
    const newline = decoded.indexOf(10, offset);
    const end = newline < 0 ? decoded.length : newline;
    const line = decoded.toString("utf8", offset, end);
    // Preserve the envelope's trailing-whitespace allowance without copying all its text.
    if (!line.trim() && !decoded.toString("utf8", offset).trimEnd()) {
      break;
    }
    const record = sessionColdRecordSchema.parse(JSON.parse(line));
    if (!headerSeen) {
      if (
        record.kind !== "header" ||
        record.sessionId !== archive.session_id ||
        record.generation !== archive.generation
      ) {
        throw new Error("Cold transcript archive metadata does not match its contents");
      }
      headerSeen = true;
    } else if (record.kind === "header") {
      throw new Error("Cold transcript archive metadata does not match its contents");
    }
    if (record.kind === "event") {
      if (
        (eventCount === 0 &&
          archive.first_seq !== undefined &&
          record.row.seq !== archive.first_seq) ||
        (lastSeq !== undefined && record.row.seq <= lastSeq)
      ) {
        throw new Error("Cold transcript archive metadata does not match its contents");
      }
      eventCount++;
      rawBytes += Buffer.byteLength(record.row.event_json) + 1;
      lastSeq = record.row.seq;
    }
    yield record;
    offset = end + 1;
  }
  if (
    !headerSeen ||
    eventCount !== archive.event_count ||
    lastSeq !== archive.last_seq ||
    rawBytes !== archive.raw_bytes
  ) {
    throw new Error("Cold transcript archive metadata does not match its contents");
  }
}
