import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordAttachment,
  ManagedImageRecordMutation,
  ManagedImageRecordCommand,
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

function readManagedImageRecordInDatabase(
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

function listManagedImageOriginalMediaIdsInDatabase(db: DatabaseSync): string[] {
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

function insertManagedImageRecordInDatabase(db: DatabaseSync, record: ManagedImageRecord): boolean {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
      .insertInto("managed_outgoing_image_records")
      .values(managedImageRecordToRow(record)),
  );
  return true;
}

/** Promote a transient record atomically so concurrent message commits cannot lose state. */
function attachManagedImageRecordInDatabase(
  db: DatabaseSync,
  params: ManagedImageRecordAttachment,
): boolean {
  const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("managed_outgoing_image_records")
      .select(MANAGED_IMAGE_RECORD_COLUMNS)
      .where("attachment_id", "=", params.attachmentId)
      .where("session_key", "=", params.sessionKey),
  );
  if (!row) {
    return false;
  }
  if (row.cleanup_pending === 1) {
    return false;
  }
  const current = managedImageRecordFromRow(row);
  if (current.messageId === params.messageId && current.retentionClass === "history") {
    return true;
  }
  const next: ManagedImageRecord = {
    ...current,
    messageId: params.messageId,
    retentionClass: "history",
    updatedAt: params.updatedAt,
  };
  const nextRow = managedImageRecordToRow(next);
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("managed_outgoing_image_records")
      .set({
        message_id: nextRow.message_id,
        retention_class: nextRow.retention_class,
        updated_at: nextRow.updated_at,
        record_json: nextRow.record_json,
      })
      .where("attachment_id", "=", params.attachmentId),
  );
  return true;
}

/** Claim only the exact row cleanup planned against; concurrent updates win. */
function claimManagedImageRecordCleanupInDatabase(
  db: DatabaseSync,
  planned: ManagedImageRecord,
): boolean {
  const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("managed_outgoing_image_records")
      .select(MANAGED_IMAGE_RECORD_COLUMNS)
      .where("attachment_id", "=", planned.attachmentId),
  );
  if (
    !row ||
    row.cleanup_pending === 1 ||
    !managedImageRecordsEqual(managedImageRecordFromRow(row), planned)
  ) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("managed_outgoing_image_records")
      .set({ cleanup_pending: 1 })
      .where("attachment_id", "=", planned.attachmentId),
  );
  return true;
}

/** Delete a durably claimed row only after its attachment file is gone. */
function deleteClaimedManagedImageRecordInDatabase(
  db: DatabaseSync,
  planned: ManagedImageRecord,
): boolean {
  const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("managed_outgoing_image_records")
      .select(MANAGED_IMAGE_RECORD_COLUMNS)
      .where("attachment_id", "=", planned.attachmentId),
  );
  if (
    !row ||
    row.cleanup_pending !== 1 ||
    !managedImageRecordsEqual(managedImageRecordFromRow(row), planned)
  ) {
    return false;
  }
  executeSqliteQuerySync(
    db,
    stateDb
      .deleteFrom("managed_outgoing_image_records")
      .where("attachment_id", "=", planned.attachmentId),
  );
  return true;
}

function executeManagedImageRecordMutation(
  command: ManagedImageRecordMutation,
  database: OpenClawStateDatabase,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      let result: boolean;
      switch (command.type) {
        case "managedImages.insert":
          result = insertManagedImageRecordInDatabase(db, command.input);
          break;
        case "managedImages.attach":
          result = attachManagedImageRecordInDatabase(db, command.input);
          break;
        case "managedImages.claimCleanup":
          result = claimManagedImageRecordCleanupInDatabase(db, command.input);
          break;
        case "managedImages.deleteClaimed":
          result = deleteClaimedManagedImageRecordInDatabase(db, command.input);
          break;
      }
      const receipt = { type: command.type, result };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return result;
    },
    { database },
    { operationLabel: command.type },
  );
}

export function isManagedImageRecordCommand(command: {
  type: string;
}): command is ManagedImageRecordCommand {
  switch (command.type) {
    case "managedImages.insert":
    case "managedImages.attach":
    case "managedImages.claimCleanup":
    case "managedImages.deleteClaimed":
    case "managedImages.read":
    case "managedImages.entries":
    case "managedImages.originalMediaIds":
      return true;
    default:
      return false;
  }
}

export function executeManagedImageRecordCommand(
  command: ManagedImageRecordCommand,
  database: OpenClawStateDatabase,
) {
  switch (command.type) {
    case "managedImages.read":
      return readManagedImageRecordInDatabase(database.db, command.input.attachmentId);
    case "managedImages.entries":
      return listManagedImageRecordEntriesInDatabase(database.db, command.input.sessionKey);
    case "managedImages.originalMediaIds":
      return listManagedImageOriginalMediaIdsInDatabase(database.db);
    default:
      return executeManagedImageRecordMutation(command, database);
  }
}
