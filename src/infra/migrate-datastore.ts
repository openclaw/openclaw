import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { resolveStateDir } from "../config/paths.js";
import { normalizeKey } from "./datastore-pg.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";
import { applyStateDbMigrations } from "./state-db-migrations.js";
import { getStateDbPool, hasStateDbConfigured } from "./state-db.js";

const KV_TABLE = "openclaw_kv";
const UPGRADE_SENTINEL = "_migration/fs-to-db";
const DOWNGRADE_MARKER = ".migrated-from-db";

/**
 * Directory basenames to skip during fs→db migration.
 * These contain user project files or non-state data that the datastore
 * layer never intended to manage.
 */
const EXCLUDED_DIRNAMES = new Set(["workspace", "sessions", "media", "logs", "node_modules"]);

/** Returns true if the directory basename looks like a workspace dir (workspace-<id>). */
function isWorkspaceDir(name: string): boolean {
  return name === "workspace" || name.startsWith("workspace-");
}

/**
 * File extensions/suffixes to skip (temporary, backup, lock files).
 */
function isExcludedFile(name: string): boolean {
  return name.endsWith(".bak") || name.endsWith(".tmp") || name.endsWith(".lock");
}

/**
 * Recursively collect OpenClaw-managed .json state files under a directory.
 * Skips workspace dirs, session logs, media, and temporary files.
 */
function collectJsonFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRNAMES.has(entry.name) || isWorkspaceDir(entry.name)) {
        continue;
      }
      results.push(...collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json") && !isExcludedFile(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Migrate filesystem JSON files into the PostgreSQL openclaw_kv table.
 * Uses INSERT ... ON CONFLICT DO NOTHING so existing DB rows are never overwritten.
 */
export async function migrateFilesystemToDatabase(pool: Pool, stateDir: string): Promise<number> {
  if (!fs.existsSync(stateDir)) {
    return 0;
  }

  const files = collectJsonFiles(stateDir);
  if (files.length === 0) {
    return 0;
  }

  let migrated = 0;
  let failed = 0;

  for (const file of files) {
    const data = loadJsonFile(file);
    if (data === undefined) {
      console.warn(`[migrate-datastore] skipping corrupt/unreadable file: ${file}`);
      failed++;
      continue;
    }

    // Build the key the same way the PG datastore would see it:
    // full path → normalizeKey strips the home prefix.
    const fullPath = file;
    const dbKey = normalizeKey(fullPath);

    try {
      await pool.query(
        `insert into ${KV_TABLE} (key, data, updated_at)
				 values ($1, $2, now())
				 on conflict (key) do nothing`,
        [dbKey, data],
      );
      migrated++;
    } catch (err) {
      failed++;
      console.warn(`[migrate-datastore] failed to import ${dbKey}:`, err);
    }
  }

  // Only write sentinel when every file was handled — partial failures
  // must allow retries on the next startup.
  if (failed === 0) {
    await pool.query(
      `insert into ${KV_TABLE} (key, data, updated_at)
		   values ($1, $2, now())
		   on conflict (key) do nothing`,
      [UPGRADE_SENTINEL, { migratedAt: new Date().toISOString(), count: migrated }],
    );
  }

  console.log(
    `[migrate-datastore] filesystem→database: imported ${migrated}/${files.length} files` +
      (failed > 0 ? ` (${failed} failed, will retry on next startup)` : ""),
  );
  return migrated;
}

/**
 * Migrate data from the PostgreSQL openclaw_kv table back to filesystem JSON files.
 * Skips files that already exist on disk.
 */
export async function migrateDatabaseToFilesystem(pool: Pool, stateDir: string): Promise<number> {
  const res = await pool.query<{ key: string; data: unknown }>(
    `select key, data from ${KV_TABLE} where key not like '_migration/%'`,
  );

  if (res.rows.length === 0) {
    return 0;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let migrated = 0;
  let failed = 0;

  for (const row of res.rows) {
    // Reconstruct file path: relative keys (no leading /) came from under
    // HOME; absolute keys are used as-is (e.g. custom OPENCLAW_STATE_DIR).
    const filePath = path.isAbsolute(row.key) ? row.key : path.join(home, row.key);

    if (fs.existsSync(filePath)) {
      continue;
    }

    try {
      saveJsonFile(filePath, row.data);
      migrated++;
    } catch (err) {
      failed++;
      console.warn(`[migrate-datastore] failed to write ${filePath}:`, err);
    }
  }

  // Only write marker when every row was handled — partial failures
  // must allow retries on the next startup.
  if (failed === 0) {
    const markerPath = path.join(stateDir, DOWNGRADE_MARKER);
    const markerDir = path.dirname(markerPath);
    if (!fs.existsSync(markerDir)) {
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ migratedAt: new Date().toISOString(), count: migrated }),
      "utf-8",
    );
  }

  console.log(
    `[migrate-datastore] database→filesystem: restored ${migrated}/${res.rows.length} keys` +
      (failed > 0 ? ` (${failed} failed, will retry on next startup)` : ""),
  );
  return migrated;
}

/**
 * Detect migration direction and run the appropriate migration if needed.
 *
 * Call after initDatastore() has set up the active datastore.
 *
 * - Upgrade (filesystem→database): OPENCLAW_DATASTORE=database, check sentinel
 * - Downgrade (database→filesystem): OPENCLAW_DATASTORE=fs + OPENCLAW_STATE_DB_URL set, check marker file
 */
export async function runDatastoreMigrationIfNeeded(
  direction: "filesystem-to-database" | "database-to-filesystem",
): Promise<void> {
  const stateDir = resolveStateDir();

  if (direction === "filesystem-to-database") {
    await runFilesystemToDatabaseMigration(stateDir);
  } else {
    await runDatabaseToFilesystemMigration(stateDir);
  }
}

async function runFilesystemToDatabaseMigration(stateDir: string): Promise<void> {
  const pool = getStateDbPool();
  if (!pool) {
    return;
  }

  await applyStateDbMigrations(pool);

  // Check sentinel in DB
  const sentinel = await pool.query<{ key: string }>(`select key from ${KV_TABLE} where key = $1`, [
    UPGRADE_SENTINEL,
  ]);
  if (sentinel.rows.length > 0) {
    return; // Already migrated
  }

  // Check if stateDir has any JSON files to migrate
  if (!fs.existsSync(stateDir)) {
    return;
  }

  await migrateFilesystemToDatabase(pool, stateDir);
}

async function runDatabaseToFilesystemMigration(stateDir: string): Promise<void> {
  if (!hasStateDbConfigured()) {
    return; // No DB URL configured, nothing to downgrade from
  }

  // Check marker file
  const markerPath = path.join(stateDir, DOWNGRADE_MARKER);
  if (fs.existsSync(markerPath)) {
    return; // Already migrated
  }

  const pool = getStateDbPool();
  if (!pool) {
    return;
  }

  await applyStateDbMigrations(pool);

  await migrateDatabaseToFilesystem(pool, stateDir);
}
