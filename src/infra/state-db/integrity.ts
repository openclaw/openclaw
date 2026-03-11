/**
 * Startup integrity check for operator1.db.
 *
 * Runs PRAGMA integrity_check on the database file.
 * If corruption is detected, renames the corrupt file and signals
 * the caller to create a fresh empty DB.
 */
import fs from "node:fs";
import { requireNodeSqlite } from "../../memory/sqlite.js";

export interface IntegrityResult {
  ok: boolean;
  error?: string;
}

/**
 * Check DB integrity. Returns { ok: true } if healthy or file doesn't exist.
 * If corrupt, renames the file to *.corrupt.{timestamp} and returns { ok: false }.
 */
export function checkStateDbIntegrity(dbPath: string): IntegrityResult {
  if (!fs.existsSync(dbPath)) {
    return { ok: true };
  }

  let db;
  try {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(dbPath, { open: true });

    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const result = rows[0]?.integrity_check;

    if (result === "ok") {
      return { ok: true };
    }

    const error = `integrity_check failed: ${rows.map((r) => r.integrity_check).join("; ")}`;
    db.close();
    db = undefined;

    renameCorruptDb(dbPath);
    return { ok: false, error };
  } catch (err) {
    const error = `integrity check error: ${err instanceof Error ? err.message : String(err)}`;
    try {
      db?.close();
    } catch {
      // ignore
    }

    // If we can't even open the file, it's likely corrupt
    renameCorruptDb(dbPath);
    return { ok: false, error };
  }
}

function renameCorruptDb(dbPath: string): void {
  const timestamp = Date.now();
  const corruptPath = `${dbPath}.corrupt.${timestamp}`;
  try {
    fs.renameSync(dbPath, corruptPath);
    // Also rename WAL/SHM files if present
    for (const suffix of ["-wal", "-shm"]) {
      const walPath = `${dbPath}${suffix}`;
      if (fs.existsSync(walPath)) {
        fs.renameSync(walPath, `${corruptPath}${suffix}`);
      }
    }
  } catch {
    // Best effort — if rename fails, the caller will still get ok: false
  }
}
