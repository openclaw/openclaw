import fsSync from "node:fs";
import fs from "node:fs/promises";
import { ignoreMissingPath } from "../infra/errno.js";
import { resolveSqliteDatabaseFilePaths, SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";

export async function assertFreshRestoreTarget(databasePath: string): Promise<void> {
  for (const candidate of resolveSqliteDatabaseFilePaths(databasePath)) {
    if (await fs.lstat(candidate).catch(ignoreMissingPath)) {
      throw new Error(`Fresh SQLite restore path already exists: ${candidate}`);
    }
  }
}

export function assertNoSqliteSidecarsSync(databasePath: string, errorPrefix: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      fsSync.lstatSync(sidecarPath);
    } catch (error) {
      ignoreMissingPath(error);
      continue;
    }
    throw new Error(`${errorPrefix}: ${sidecarPath}`);
  }
}
