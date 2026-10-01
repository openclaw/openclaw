import {
  deleteSessionSnapshotDatabaseRecord,
  resetSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  publishSnapshotInvalidation,
  type SessionSnapshotInvalidationReason,
} from "./session-snapshot-invalidation-events.ts";

export async function deleteStoredChatSnapshot(
  sessionKey: string,
  reason?: SessionSnapshotInvalidationReason,
): Promise<void> {
  await publishSnapshotInvalidation({ sessionKey, ...(reason ? { reason } : {}) });
  await deleteSessionSnapshotDatabaseRecord(sessionKey);
}

export async function clearStoredChatSnapshots(): Promise<void> {
  await publishSnapshotInvalidation({});
  await resetSessionSnapshotDatabase();
}
