import { requireNodeSqlite, resolveSqliteFilesystemPath } from "./node-sqlite.js";

export async function backupNodeSqliteDatabase(
  source: import("node:sqlite").DatabaseSync,
  targetPath: string,
  onProgress?: (progress: import("node:sqlite").BackupProgressInfo) => void,
): Promise<number> {
  // Native backup resolves outside Node's callback scopes, leaving idle awaits asleep.
  // Remove when supported runtimes checkpoint backup completion themselves.
  const checkpoint = setInterval(() => {}, 100);
  try {
    const totalPages = await requireNodeSqlite().backup(
      source,
      resolveSqliteFilesystemPath(targetPath),
      {
        progress: onProgress,
      },
    );
    // Node reports intermediate steps only; the resolved count owns completion.
    onProgress?.({ totalPages, remainingPages: 0 });
    return totalPages;
  } finally {
    clearInterval(checkpoint);
  }
}
