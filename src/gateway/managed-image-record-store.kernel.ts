import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordDatabase,
  ManagedImageRecordRow,
  ManagedImageRecordInsert,
  ManagedImageRecordEntry,
} from "./managed-image-record-store.types.js";

export const MANAGED_IMAGE_RECORD_COLUMNS = [
  "attachment_id",
  "session_key",
  "agent_id",
  "message_id",
  "created_at",
  "updated_at",
  "retention_class",
  "alt",
  "original_media_root",
  "original_media_id",
  "original_media_subdir",
  "original_content_type",
  "original_width",
  "original_height",
  "original_size_bytes",
  "original_filename",
  "cleanup_pending",
] as const satisfies readonly (keyof ManagedImageRecordRow)[];

export function managedImageRecordToRow(record: ManagedImageRecord): ManagedImageRecordInsert {
  return {
    attachment_id: record.attachmentId,
    session_key: record.sessionKey,
    agent_id: record.agentId ?? null,
    message_id: record.messageId,
    created_at: record.createdAt,
    updated_at: record.updatedAt ?? null,
    retention_class: record.retentionClass ?? null,
    alt: record.alt,
    original_media_root: record.original.mediaRoot,
    original_media_id: record.original.mediaId,
    original_media_subdir: record.original.mediaSubdir,
    original_content_type: record.original.contentType,
    original_width: record.original.width,
    original_height: record.original.height,
    original_size_bytes: record.original.sizeBytes,
    original_filename: record.original.filename,
    record_json: JSON.stringify(record),
  };
}

export function managedImageRecordFromRow(row: ManagedImageRecordRow): ManagedImageRecord {
  return {
    attachmentId: row.attachment_id,
    sessionKey: row.session_key,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    messageId: row.message_id,
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.retention_class === "history" || row.retention_class === "transient"
      ? { retentionClass: row.retention_class }
      : {}),
    alt: row.alt,
    original: {
      mediaRoot: row.original_media_root,
      mediaId: row.original_media_id,
      mediaSubdir: row.original_media_subdir,
      contentType: row.original_content_type,
      width: row.original_width,
      height: row.original_height,
      sizeBytes: row.original_size_bytes,
      filename: row.original_filename,
    },
  };
}

export function managedImageRecordsEqual(
  left: ManagedImageRecord,
  right: ManagedImageRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readManagedImageRecordInDatabase(
  db: DatabaseSync,
  attachmentId: string,
): ManagedImageRecord | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
      .selectFrom("managed_outgoing_image_records")
      .select(MANAGED_IMAGE_RECORD_COLUMNS)
      .where("attachment_id", "=", attachmentId)
      .where("cleanup_pending", "=", 0),
  );
  return row ? managedImageRecordFromRow(row) : null;
}

export function listManagedImageRecordEntriesInDatabase(
  db: DatabaseSync,
  sessionKey?: string,
): ManagedImageRecordEntry[] {
  const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
  let query = stateDb
    .selectFrom("managed_outgoing_image_records")
    .select(MANAGED_IMAGE_RECORD_COLUMNS);
  if (sessionKey) {
    query = query.where("session_key", "=", sessionKey);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("created_at", "desc").orderBy("attachment_id", "asc"),
  ).rows.map((row) => ({
    record: managedImageRecordFromRow(row),
    cleanupPending: row.cleanup_pending === 1,
  }));
}

export function listManagedImageOriginalMediaIdsInDatabase(db: DatabaseSync): string[] {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
      .selectFrom("managed_outgoing_image_records")
      // Preserve native integer decoding failures before destructive orphan cleanup.
      .select([
        "original_media_id",
        "original_width",
        "original_height",
        "original_size_bytes",
        "cleanup_pending",
      ])
      .orderBy("created_at", "desc")
      .orderBy("attachment_id", "asc"),
  ).rows.map((row) => row.original_media_id);
}
