/**
 * Pure decision logic for whether sessions should be synced during a memory
 * index operation. Extracted to a standalone module so tests can import the
 * real production logic without pulling in the full MemoryIndexManager class
 * hierarchy (which triggers circular-dependency issues in test isolation).
 */
export function shouldSyncSessionsLogic(
  hasSessions: boolean,
  params: { reason?: string; force?: boolean; sessionFiles?: string[] } | undefined,
  needsFullReindex: boolean,
  sessionsDirty: boolean,
  sessionsDirtyFilesCount: number,
): boolean {
  if (!hasSessions) {
    return false;
  }
  if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
    return true;
  }
  if (params?.force) {
    return true;
  }
  // Full reindex must include sessions regardless of the trigger reason;
  // otherwise a session-start or watch trigger that coincides with a
  // config/model change silently drops session data from the new index.
  if (needsFullReindex) {
    return true;
  }
  const reason = params?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return sessionsDirty && sessionsDirtyFilesCount > 0;
}
