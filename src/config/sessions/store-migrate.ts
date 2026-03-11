/**
 * One-shot migration: JSON session stores → SQLite.
 *
 * Reads each agent's `sessions.json`, inserts entries into `session_entries`,
 * and deletes the source JSON file on success.
 *
 * Safe to run multiple times — skips agents that have no JSON file.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../../infra/state-db/connection.js";
import { resolveStateDir } from "../paths.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { saveSessionEntriesToDb } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

export type SessionMigrationResult = {
  agent: string;
  entriesCount: number;
  migrated: boolean;
  error?: string;
};

/** Migrate all agent session JSON files to SQLite. Returns a result per agent. */
export function migrateSessionStoresToSqlite(
  env: NodeJS.ProcessEnv = process.env,
  db?: DatabaseSync,
): SessionMigrationResult[] {
  const conn = db ?? getStateDb();
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");

  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const results: SessionMigrationResult[] = [];
  const agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true });

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const agentId = dirent.name;
    const sessionsJsonPath = path.join(agentsDir, agentId, "sessions", "sessions.json");

    if (!fs.existsSync(sessionsJsonPath)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(sessionsJsonPath, "utf-8");
      if (!raw.trim()) {
        // Empty file — nothing to migrate, just remove it
        fs.unlinkSync(sessionsJsonPath);
        results.push({ agent: agentId, entriesCount: 0, migrated: true });
        continue;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        // Invalid format — remove the file
        fs.unlinkSync(sessionsJsonPath);
        results.push({ agent: agentId, entriesCount: 0, migrated: true });
        continue;
      }

      const store = parsed as Record<string, SessionEntry>;

      // Apply legacy migrations (provider → channel rename, etc.)
      applySessionStoreMigrations(store);

      const entryCount = Object.keys(store).length;

      // Write to SQLite
      saveSessionEntriesToDb(agentId, store, conn);

      // Delete the source JSON file
      fs.unlinkSync(sessionsJsonPath);

      // Also clean up .bak rotation files
      cleanupRotationBackups(sessionsJsonPath);

      results.push({ agent: agentId, entriesCount: entryCount, migrated: true });
    } catch (err) {
      results.push({
        agent: agentId,
        entriesCount: 0,
        migrated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/** Remove legacy rotation backup files (sessions.json.bak.*). */
function cleanupRotationBackups(sessionsJsonPath: string): void {
  try {
    const dir = path.dirname(sessionsJsonPath);
    const baseName = path.basename(sessionsJsonPath);
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(`${baseName}.bak.`)) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
