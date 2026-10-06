import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveSessionArtifactDirectory } from "./paths.js";

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
  const bytes =
    archive.storage === "sqlite"
      ? Buffer.from(archive.archive_blob ?? [])
      : await fs
          .readFile(resolveSessionColdArchivePath(params.storePath, archive.archive_name))
          .catch((error: unknown) => {
            throw new Error(
              `Cold transcript archive ${archive.archive_name} is missing or unreadable. Restore it from a backup; its transcript has not been replaced with empty history.`,
              { cause: error },
            );
          });
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
