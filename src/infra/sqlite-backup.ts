import { requireNodeSqlite, resolveSqliteFilesystemPath } from "./node-sqlite.js";

export async function backupNodeSqliteDatabase(
  source: import("node:sqlite").DatabaseSync,
  targetPath: string,
): Promise<number> {
  // Native backup resolves outside Node's callback scopes, leaving idle awaits asleep.
  // Remove when supported runtimes checkpoint backup completion themselves.
  const checkpoint = setInterval(() => {}, 100);
  try {
    return await requireNodeSqlite().backup(source, resolveSqliteFilesystemPath(targetPath));
  } finally {
    clearInterval(checkpoint);
  }
}
