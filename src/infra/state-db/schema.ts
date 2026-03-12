/**
 * Schema version tracking and table definitions for operator1.db.
 *
 * Migrations are idempotent — safe to run on every startup.
 * Each migration is wrapped in a transaction with version tracking.
 */
import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

// ── Migration definitions ───────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "P0 tables: sessions, delivery queue, teams",
    up(db) {
      // -- Sessions (replaces per-agent sessions.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_entries (
          agent_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          session_id TEXT,
          session_file TEXT,
          channel TEXT,
          last_channel TEXT,
          last_to TEXT,
          last_account_id TEXT,
          last_thread_id TEXT,
          delivery_context_json TEXT,
          origin_json TEXT,
          display_name TEXT,
          group_name TEXT,
          model TEXT,
          department TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          extra_json TEXT,
          PRIMARY KEY (agent_id, session_key)
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_session_entries_updated ON session_entries(updated_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_session_entries_channel ON session_entries(agent_id, channel)",
      );

      // -- Delivery queue (replaces delivery-queue/*.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS delivery_queue (
          queue_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3,
          next_attempt_at INTEGER,
          last_attempted_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()),
          delivered_at INTEGER,
          failed_at INTEGER,
          error TEXT
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_delivery_queue_status ON delivery_queue(status)");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_delivery_queue_retry
        ON delivery_queue(status, next_attempt_at)
        WHERE status = 'pending'
      `);

      // -- Teams: operator1-owned, normalized tables
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_team_registry (
          team_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT,
          config_json TEXT,
          created_at INTEGER,
          updated_at INTEGER
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_team_members (
          team_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          role TEXT,
          joined_at INTEGER,
          PRIMARY KEY (team_id, agent_id),
          FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_team_tasks (
          task_id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          title TEXT,
          status TEXT,
          assigned_to TEXT,
          priority INTEGER DEFAULT 0,
          result_json TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_team_tasks_status ON op1_team_tasks(team_id, status)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_team_tasks_assigned ON op1_team_tasks(assigned_to)",
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_team_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          agent_id TEXT,
          role TEXT,
          content TEXT,
          metadata_json TEXT,
          created_at INTEGER,
          FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_team_messages_team ON op1_team_messages(team_id, created_at)",
      );
    },
  },
  {
    version: 2,
    description: "P2: extend team tables with missing columns for TypeScript types",
    up(db) {
      // op1_team_registry: add leader, leader_session, completed_at
      db.exec("ALTER TABLE op1_team_registry ADD COLUMN leader TEXT");
      db.exec("ALTER TABLE op1_team_registry ADD COLUMN leader_session TEXT");
      db.exec("ALTER TABLE op1_team_registry ADD COLUMN completed_at INTEGER");

      // op1_team_members: recreate to drop PRIMARY KEY (team_id, agent_id) —
      // duplicate agent_id per team is allowed (multiple sessions).
      db.exec("ALTER TABLE op1_team_members RENAME TO op1_team_members_old");
      db.exec(`
        CREATE TABLE op1_team_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          role TEXT,
          joined_at INTEGER,
          session_key TEXT,
          state TEXT DEFAULT 'idle',
          FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO op1_team_members (team_id, agent_id, role, joined_at)
        SELECT team_id, agent_id, role, joined_at FROM op1_team_members_old
      `);
      db.exec("DROP TABLE op1_team_members_old");

      // op1_team_tasks: add description, blocked_by_json
      db.exec("ALTER TABLE op1_team_tasks ADD COLUMN description TEXT");
      db.exec("ALTER TABLE op1_team_tasks ADD COLUMN blocked_by_json TEXT");

      // op1_team_messages: add message_id (UUID), from_agent, to_agent, read_by_json
      db.exec("ALTER TABLE op1_team_messages ADD COLUMN message_id TEXT");
      db.exec("ALTER TABLE op1_team_messages ADD COLUMN from_agent TEXT");
      db.exec("ALTER TABLE op1_team_messages ADD COLUMN to_agent TEXT");
      db.exec("ALTER TABLE op1_team_messages ADD COLUMN read_by_json TEXT");
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/** Run all pending migrations. Idempotent — skips already-applied versions. */
export function runMigrations(db: DatabaseSync): void {
  // Ensure version tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch()),
      description TEXT
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM core_schema_version").all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO core_schema_version (version, description) VALUES (?, ?)").run(
        migration.version,
        migration.description,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `State DB migration v${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/** Get the current schema version (0 if no migrations applied). */
export function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT MAX(version) as v FROM core_schema_version").get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

/** List all table names in the database (excludes sqlite internals). */
export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Get row count for a table. */
export function getTableRowCount(db: DatabaseSync, tableName: string): number {
  // Table name is from our own listTables() — safe to interpolate
  const row = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get() as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}
