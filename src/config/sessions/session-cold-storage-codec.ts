import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import { resolveSessionArtifactDirectory } from "./paths.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";

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

export function decodeSessionColdRecords(
  bytes: Uint8Array,
  archive: Pick<
    SessionColdArchive,
    "session_id" | "generation" | "event_count" | "raw_bytes" | "last_seq"
  > & { first_seq?: number },
): SessionColdRecord[] {
  const records = zlib
    .zstdDecompressSync(bytes, { maxOutputLength: MAX_COLD_ARCHIVE_BYTES })
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => sessionColdRecordSchema.parse(JSON.parse(line)));
  const header = records[0];
  const events = records.filter((record) => record.kind === "event");
  if (
    header?.kind !== "header" ||
    header.sessionId !== archive.session_id ||
    header.generation !== archive.generation ||
    records.slice(1).some((record) => record.kind === "header") ||
    events.length !== archive.event_count ||
    (archive.first_seq !== undefined && events[0]?.row.seq !== archive.first_seq) ||
    events.some((event, index) => index > 0 && event.row.seq <= events[index - 1]!.row.seq) ||
    events.at(-1)?.row.seq !== archive.last_seq ||
    events.reduce((sum, event) => sum + Buffer.byteLength(event.row.event_json), 0) +
      events.length -
      1 !==
      archive.raw_bytes
  ) {
    throw new Error("Cold transcript archive metadata does not match its contents");
  }
  return records;
}
