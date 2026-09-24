import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  MANAGED_IMAGE_RECORD_COLUMNS,
  managedImageRecordToRow,
  managedImageRecordFromRow,
  managedImageRecordsEqual,
} from "./managed-image-record-store.kernel.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordDatabase,
  ManagedImageWriteOperations,
} from "./managed-image-record-store.types.js";

export function isManagedImageMutation(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<ManagedImageWriteOperations> {
  return (
    command.type === "managedImages.insert" ||
    command.type === "managedImages.attach" ||
    command.type === "managedImages.claimCleanup" ||
    command.type === "managedImages.deleteClaimed"
  );
}

export function executeManagedImageMutation(
  command: SqliteWorkerCommand<ManagedImageWriteOperations>,
  options: OpenClawStateDatabaseOptions,
) {
  switch (command.type) {
    case "managedImages.insert":
      return insertManagedImageRecord(command.input.record, options);
    case "managedImages.attach":
      return attachManagedImageRecordToMessage({ ...command.input, options });
    case "managedImages.claimCleanup":
      return claimManagedImageRecordCleanupIfCurrent(command.input.record, options);
    case "managedImages.deleteClaimed":
      return deleteClaimedManagedImageRecord(command.input.record, options);
  }
}

function insertManagedImageRecord(
  record: ManagedImageRecord,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
        .insertInto("managed_outgoing_image_records")
        .values(managedImageRecordToRow(record)),
    );
  }, options);
}

/** Promote a transient record atomically so concurrent message commits cannot lose state. */
function attachManagedImageRecordToMessage(params: {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
  options: OpenClawStateDatabaseOptions;
}): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
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
  }, params.options);
}

/** Claim only the exact row cleanup planned against; concurrent updates win. */
function claimManagedImageRecordCleanupIfCurrent(
  planned: ManagedImageRecord,
  options: OpenClawStateDatabaseOptions,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
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
  }, options);
}

/** Delete a durably claimed row only after its attachment file is gone. */
function deleteClaimedManagedImageRecord(
  planned: ManagedImageRecord,
  options: OpenClawStateDatabaseOptions,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
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
  }, options);
}
