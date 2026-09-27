// Canonical shared-SQLite store for managed outgoing image metadata.
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  MANAGED_IMAGE_RECORD_COLUMNS,
  managedImageRecordToRow,
  managedImageRecordFromRow,
  managedImageRecordsEqual,
} from "./managed-image-record-store.kernel.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordDatabase,
  ManagedImageRecordEntry,
} from "./managed-image-record-store.types.js";

export {
  managedImageRecordToRow,
  managedImageRecordFromRow,
  managedImageRecordsEqual,
} from "./managed-image-record-store.kernel.js";
export type {
  ManagedImageRecord,
  ManagedImageRecordDatabase,
} from "./managed-image-record-store.types.js";
export const MANAGED_OUTGOING_ORIGINALS_SUBDIR = "outgoing/originals";

function stateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

function captureManagedImageReadContext(stateDir?: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  if (stateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }
  return captureOpenClawStateWorkerContext({ env });
}

export async function readManagedImageRecord(
  attachmentId: string,
  stateDir?: string,
): Promise<ManagedImageRecord | null> {
  const context = captureManagedImageReadContext(stateDir);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.read",
    input: { attachmentId },
  });
}

export async function listManagedImageRecordEntries(params: {
  stateDir?: string;
  sessionKey?: string;
}): Promise<ManagedImageRecordEntry[]> {
  const context = captureManagedImageReadContext(params.stateDir);
  const sessionKey = params.sessionKey;
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.entries",
    input: { sessionKey },
  });
}

export async function listManagedImageOriginalMediaIds(stateDir?: string): Promise<string[]> {
  const context = captureManagedImageReadContext(stateDir);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.originalMediaIds",
    input: undefined,
  });
}

export function insertManagedImageRecord(record: ManagedImageRecord, stateDir?: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
        .insertInto("managed_outgoing_image_records")
        .values(managedImageRecordToRow(record)),
    );
  }, stateDatabaseOptions(stateDir));
}

/** Promote a transient record atomically so concurrent message commits cannot lose state. */
export function attachManagedImageRecordToMessage(params: {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
  stateDir?: string;
}): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
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
  }, stateDatabaseOptions(params.stateDir));
}

/** Claim only the exact row cleanup planned against; concurrent updates win. */
export function claimManagedImageRecordCleanupIfCurrent(
  planned: ManagedImageRecord,
  stateDir?: string,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
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
  }, stateDatabaseOptions(stateDir));
}

/** Delete a durably claimed row only after its attachment file is gone. */
export function deleteClaimedManagedImageRecord(
  planned: ManagedImageRecord,
  stateDir?: string,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
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
  }, stateDatabaseOptions(stateDir));
}
