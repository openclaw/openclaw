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
 * Apply `PRAGMA mmap_size = 0` when SQLite memory-mapped I/O is disabled.
 *
 * Controlled by the `OPENCLAW_SQLITE_MMAP` env var:
 *   - "0" or "false" → disables mmap (applies the pragma)
 *   - unset or any other value → mmap stays enabled (default)
 *
 * The env var is bridged from `storage.sqliteMmap` in openclaw.json
 * during config loading (see `applySqliteMmapConfigBridge`), so both
 * the env var and config file approaches work.
 *
 * Disable on NFS-backed volumes to prevent SIGBUS crashes: WAL mode's
 * shared-memory (-shm) files rely on mmap, which NFS does not support
 * reliably. A transient server interruption causes the kernel to deliver
 * SIGBUS when the process accesses a page no longer backed by the server.
 */
export function applySqliteMmapPragma(db: { exec: (sql: string) => void }): void {
  const envVal = process.env.OPENCLAW_SQLITE_MMAP?.trim().toLowerCase();
  if (envVal === "0" || envVal === "false") {
    db.exec("PRAGMA mmap_size = 0");
  }
}

/**
 * Bridge `storage.sqliteMmap` from openclaw.json to the
 * `OPENCLAW_SQLITE_MMAP` env var. Call during config loading,
 * before any SQLite databases are opened.
 *
 * Does not overwrite an existing env var (env takes precedence).
 */
export function applySqliteMmapConfigBridge(
  config: { storage?: { sqliteMmap?: boolean } },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.OPENCLAW_SQLITE_MMAP?.trim()) {
    return; // env var already set, takes precedence
  }
  if (config.storage?.sqliteMmap === false) {
    env.OPENCLAW_SQLITE_MMAP = "0";
  }
}
