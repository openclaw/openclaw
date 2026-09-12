// Safety checks and auto-backup for agent database operations.
// Prevents silent data loss during schema migrations and gateway reinstalls.
//
// Incident 2026-09-12: A ghost install's `gateway install --force` could have
// reinitialized a production agent database, destroying session history without
// warning. This module provides defense-in-depth:
//   1. Auto-backup before any schema migration that modifies existing data
//   2. Data-loss gate that aborts if sessions would be destroyed without explicit consent
//   3. CLI `--accept-data-loss` flag for controlled override
//   4. `gateway backup --agent` command for manual backups
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const safetyLog = createSubsystemLogger("state/agent-db-safety");

/** Directory name for auto-backups, relative to the agent state directory. */
export const AGENT_DB_BACKUP_DIR = "backups";

/** Maximum number of auto-backups to keep per agent database. */
export const MAX_AUTO_BACKUPS = 5;

/** Minimum number of session rows that triggers the data-loss gate. */
const DATA_LOSS_SESSION_THRESHOLD = 1;

/**
 * Resolve the backup directory for agent database files.
 * Creates the directory if it doesn't exist.
 */
export function resolveAgentDbBackupDir(agentStateDir: string): string {
  const backupDir = path.join(agentStateDir, AGENT_DB_BACKUP_DIR);
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}

/**
 * Create a timestamped backup of the agent SQLite database file.
 * Returns the path to the backup file, or undefined if the source doesn't exist.
 *
 * Auto-backups are defense-in-depth: they happen before any schema migration
 * regardless of whether `--accept-data-loss` is set. The operator can always
 * restore from the backup if something goes wrong.
 */
export function createAgentDbAutoBackup(
  dbPath: string,
  agentStateDir: string,
): string | undefined {
  if (!existsSync(dbPath)) {
    safetyLog("no-backup-needed", { reason: "database-file-does-not-exist", path: dbPath });
    return undefined;
  }

  const stat = statSync(dbPath);
  if (stat.size === 0) {
    safetyLog("no-backup-needed", { reason: "database-file-is-empty", path: dbPath });
    return undefined;
  }

  const backupDir = resolveAgentDbBackupDir(agentStateDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(dbPath, ".sqlite");
  const backupName = `${baseName}.auto-backup-${timestamp}.sqlite`;
  const backupPath = path.join(backupDir, backupName);

  try {
    copyFileSync(dbPath, backupPath);
    safetyLog("auto-backup-created", { source: dbPath, backup: backupPath, sizeBytes: stat.size });

    // Prune old backups beyond the retention limit
    pruneAgentDbAutoBackups(backupDir, baseName);
    return backupPath;
  } catch (err) {
    // Auto-backup failure is a warning, not a hard block.
    // The operator can still proceed, but they should know.
    safetyLog("auto-backup-failed", {
      source: dbPath,
      error: String(err),
      warning: "Auto-backup before schema migration failed. Proceed with caution.",
    });
    return undefined;
  }
}

/** Prune auto-backups beyond the retention limit, keeping the most recent. */
export function pruneAgentDbAutoBackups(backupDir: string, baseName: string): void {
  try {
    const prefix = `${baseName}.auto-backup-`;
    const files = readdirSync(backupDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".sqlite"))
      .sort()
      .reverse(); // newest first

    if (files.length > MAX_AUTO_BACKUPS) {
      for (let i = MAX_AUTO_BACKUPS; i < files.length; i++) {
        const filePath = path.join(backupDir, files[i]);
        try {
          unlinkSync(filePath);
          safetyLog("pruned-old-backup", { path: filePath });
        } catch {
          // Best-effort pruning; don't block the migration
        }
      }
    }
  } catch {
    // Best-effort; don't block the migration
  }
}

/**
 * Check whether a database has session data that would be at risk during
 * a schema migration that recreates tables from scratch.
 *
 * Returns the count of session rows if the database has meaningful data,
 * or 0 if the database is empty/fresh.
 */
export function countAgentSessions(db: DatabaseSync): number {
  try {
    // Check if the sessions table exists
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")
      .get();
    if (!tableExists) {
      return 0;
    }

    const result = db.prepare("SELECT count(*) as cnt FROM sessions").get() as { cnt: number };
    return result?.cnt ?? 0;
  } catch {
    // If we can't query, assume no sessions (fresh database)
    return 0;
  }
}

/**
 * Check whether a database has meaningful data beyond just schema tables.
 * This catches the case where the schema was created but never populated.
 */
export function hasAgentDatabaseData(db: DatabaseSync): boolean {
  try {
    const tables = ["sessions", "session_nodes", "conversations"] as const;
    for (const table of tables) {
      const tableExists = db
        .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`)
        .get(table);
      if (tableExists) {
        const result = db.prepare(`SELECT count(*) as cnt FROM ${table}`).get() as { cnt: number };
        if ((result?.cnt ?? 0) > 0) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export class AgentDataLossError extends Error {
  readonly code = "AGENT_DATA_LOSS_BLOCKED";

  constructor(
    readonly dbPath: string,
    readonly sessionCount: number,
  ) {
    super(
      `Agent database at ${dbPath} contains ${sessionCount} session(s). ` +
        `A schema migration that recreates tables would destroy this data.\n` +
        `\n` +
        `To proceed, use: openclaw gateway install --force --accept-data-loss\n` +
        `To create a manual backup first: openclaw gateway backup --agent <name>\n` +
        `\n` +
        `An auto-backup has been created. Check ${dbPath.replace(".sqlite", "")}/backups/`,
    );
    this.name = "AgentDataLossError";
  }
}

/**
 * Run the pre-migration safety check: auto-backup and data-loss gate.
 *
 * This is called before `ensureOpenClawAgentSchema` when the database
 * already exists and has a schema version that requires migration.
 *
 * @returns The path to the auto-backup, if created
 * @throws AgentDataLossError if the database has session data and the
 *   migration would risk data loss without explicit `--accept-data-loss`
 */
export function runPreMigrationSafetyCheck(params: {
  db: DatabaseSync;
  dbPath: string;
  agentStateDir: string;
  agentId: string;
  currentSchemaVersion: number;
  targetSchemaVersion: number;
  acceptDataLoss: boolean;
}): string | undefined {
  const { db, dbPath, agentStateDir, agentId, currentSchemaVersion, targetSchemaVersion, acceptDataLoss } = params;

  // No migration needed = no risk
  if (currentSchemaVersion >= targetSchemaVersion) {
    safetyLog("no-migration-needed", {
      agentId,
      currentSchemaVersion,
      targetSchemaVersion,
    });
    return undefined;
  }

  // Fresh database (schema version 0 = brand new) = no existing data at risk
  if (currentSchemaVersion === 0) {
    safetyLog("fresh-database", { agentId, dbPath });
    return undefined;
  }

  // Auto-backup before any migration of existing data (defense in depth)
  const backupPath = createAgentDbAutoBackup(dbPath, agentStateDir);

  // Check for session data that would be at risk
  const sessionCount = countAgentSessions(db);
  const hasData = sessionCount >= DATA_LOSS_SESSION_THRESHOLD;

  safetyLog("pre-migration-check", {
    agentId,
    dbPath,
    currentSchemaVersion,
    targetSchemaVersion,
    sessionCount,
    hasData,
    acceptDataLoss,
  });

  // V1 migration recreates the sessions table from scratch, which destroys data
  // Only block if there's actual data AND we're crossing the v1 boundary
  const isV1Migration = currentSchemaVersion < 2;
  if (hasData && isV1Migration && !acceptDataLoss) {
    throw new AgentDataLossError(dbPath, sessionCount);
  }

  // For non-v1 migrations, we still auto-backed up but don't block
  // (these are additive ALTER TABLE operations that preserve data)
  return backupPath;
}