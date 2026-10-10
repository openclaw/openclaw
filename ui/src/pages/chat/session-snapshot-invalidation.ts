import {
  deleteSessionSnapshotEntries,
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
  await deleteSessionSnapshotEntries(sessionKey, "key");
}

export async function clearStoredChatSnapshots(scopePrefix?: string): Promise<void> {
  await publishSnapshotInvalidation(scopePrefix ? { scopePrefix } : {});
  if (scopePrefix) {
    await deleteSessionSnapshotEntries(scopePrefix, "prefix");
  } else {
    await resetSessionSnapshotDatabase();
  }
}
