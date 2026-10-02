import {
  publishSnapshotInvalidation,
  type SessionSnapshotInvalidationReason,
} from "./session-snapshot-invalidation-events.ts";

export async function deleteStoredChatSnapshot(
  sessionKey: string,
  reason?: SessionSnapshotInvalidationReason,
): Promise<void> {
  await publishSnapshotInvalidation({ sessionKey, ...(reason ? { reason } : {}) });
  const { deleteSessionSnapshotDatabaseRecord } = await import("./session-snapshot-database.ts");
  await deleteSessionSnapshotDatabaseRecord(sessionKey);
}

export async function clearStoredChatSnapshots(scopePrefix?: string): Promise<void> {
  await publishSnapshotInvalidation(scopePrefix ? { scopePrefix } : {});
  const { deleteSessionSnapshotScope, resetSessionSnapshotDatabase } =
    await import("./session-snapshot-database.ts");
  if (scopePrefix) {
    await deleteSessionSnapshotScope(scopePrefix);
  } else {
    await resetSessionSnapshotDatabase();
  }
}
