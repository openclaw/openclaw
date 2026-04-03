import { createRequire } from "node:module";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);

export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

/**
 * Returns true if SQLite memory-mapped I/O should be enabled.
 *
 * Resolution order (first defined wins):
 *   1. `OPENCLAW_SQLITE_MMAP` env var — "0" or "false" disables mmap
 *   2. `storage.sqliteMmap` in openclaw.json
 *   3. Default: true (preserves existing behaviour)
 *
 * Disable on NFS-backed volumes to prevent SIGBUS crashes: WAL mode's
 * shared-memory (-shm) files rely on mmap, which NFS does not support
 * reliably. A transient server interruption causes the kernel to deliver
 * SIGBUS when the process accesses a page no longer backed by the server.
 */
export function isSqliteMmapEnabled(config?: { storage?: { sqliteMmap?: boolean } }): boolean {
  const envVal = process.env.OPENCLAW_SQLITE_MMAP?.trim().toLowerCase();
  if (envVal === "0" || envVal === "false") {
    return false;
  }
  if (envVal === "1" || envVal === "true") {
    return true;
  }
  if (config?.storage?.sqliteMmap !== undefined) {
    return config.storage.sqliteMmap;
  }
  return true;
}

/**
 * Apply `PRAGMA mmap_size = 0` when mmap is disabled.
 * Call after opening a database connection.
 */
export function applySqliteMmapPragma(
  db: { exec: (sql: string) => void },
  config?: { storage?: { sqliteMmap?: boolean } },
): void {
  if (!isSqliteMmapEnabled(config)) {
    db.exec("PRAGMA mmap_size = 0");
  }
}
