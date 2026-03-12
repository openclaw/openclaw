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
  {
    version: 3,
    description: "P3: subagent runs, auth profiles, pairing, allowlists, thread bindings",
    up(db) {
      // -- Subagent runs (replaces subagents/runs.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_subagent_runs (
          run_id TEXT PRIMARY KEY,
          child_session_key TEXT NOT NULL,
          requester_session_key TEXT NOT NULL,
          requester_display_key TEXT,
          requester_origin_json TEXT,
          task TEXT,
          cleanup TEXT DEFAULT 'delete',
          label TEXT,
          model TEXT,
          workspace_dir TEXT,
          run_timeout_seconds INTEGER,
          spawn_mode TEXT,
          created_at INTEGER,
          started_at INTEGER,
          ended_at INTEGER,
          outcome_json TEXT,
          archive_at_ms INTEGER,
          cleanup_completed_at INTEGER,
          cleanup_handled INTEGER DEFAULT 0,
          suppress_announce_reason TEXT,
          expects_completion_message INTEGER DEFAULT 0,
          announce_retry_count INTEGER DEFAULT 0,
          last_announce_retry_at INTEGER,
          ended_reason TEXT,
          wake_on_descendant_settle INTEGER DEFAULT 0,
          frozen_result_text TEXT,
          frozen_result_captured_at INTEGER,
          fallback_frozen_result_text TEXT,
          fallback_frozen_result_captured_at INTEGER,
          ended_hook_emitted_at INTEGER,
          attachments_dir TEXT,
          attachments_root_dir TEXT,
          retain_attachments_on_keep INTEGER DEFAULT 0,
          team_run_id TEXT,
          spawn_retry_count INTEGER DEFAULT 0,
          agent_id TEXT
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_subagent_runs_session ON op1_subagent_runs(child_session_key)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_subagent_runs_requester ON op1_subagent_runs(requester_session_key)",
      );

      // -- Auth profiles (replaces auth-profiles.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_auth_profiles (
          profile_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          provider TEXT NOT NULL,
          credential_json TEXT,
          email TEXT,
          metadata_json TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_auth_profiles_provider ON op1_auth_profiles(provider)",
      );

      // Auth profile ordering + usage stats (companion tables)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_auth_profile_order (
          provider TEXT PRIMARY KEY,
          profile_ids_json TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_auth_profile_usage (
          profile_id TEXT PRIMARY KEY,
          stats_json TEXT NOT NULL,
          FOREIGN KEY (profile_id) REFERENCES op1_auth_profiles(profile_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_auth_profile_last_good (
          provider TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL
        )
      `);

      // -- Channel pairing requests (replaces credentials/*-pairing.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_channel_pairing (
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL,
          code TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          meta_json TEXT,
          PRIMARY KEY (channel, account_id, sender_id)
        )
      `);

      // -- Channel allowlists (replaces credentials/*-allowFrom.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_channel_allowlist (
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL,
          added_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (channel, account_id, sender_id)
        )
      `);

      // -- Thread bindings: unified for telegram + discord
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_channel_thread_bindings (
          binding_key TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT '',
          thread_id TEXT NOT NULL,
          channel_id TEXT,
          target_kind TEXT NOT NULL,
          target_session_key TEXT NOT NULL,
          agent_id TEXT,
          label TEXT,
          bound_by TEXT DEFAULT 'system',
          bound_at INTEGER,
          last_activity_at INTEGER,
          idle_timeout_ms INTEGER,
          max_age_ms INTEGER,
          webhook_id TEXT,
          webhook_token TEXT,
          extra_json TEXT
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_thread_bindings_session ON op1_channel_thread_bindings(target_session_key)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_thread_bindings_account ON op1_channel_thread_bindings(channel_type, account_id)",
      );
    },
  },
  {
    version: 4,
    description:
      "P4: core settings KV, cron, channel state, credentials, exec approvals, workspace, clawhub",
    up(db) {
      // -- Core settings KV (replaces voicewake.json, tts.json, device.json, device-auth.json,
      //    restart-sentinel.json, update-check.json, apns-registrations.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_settings (
          scope TEXT NOT NULL,
          key TEXT NOT NULL DEFAULT '',
          value_json TEXT,
          updated_at INTEGER,
          PRIMARY KEY (scope, key)
        )
      `);

      // -- Cron jobs (replaces cron/jobs.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS cron_jobs (
          job_id TEXT PRIMARY KEY,
          job_json TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER,
          updated_at INTEGER
        )
      `);

      // -- Cron runs (replaces cron/runs/*.jsonl)
      db.exec(`
        CREATE TABLE IF NOT EXISTS cron_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          status TEXT,
          summary TEXT,
          error TEXT,
          delivered INTEGER DEFAULT 0,
          delivery_status TEXT,
          delivery_error TEXT,
          session_id TEXT,
          session_key TEXT,
          run_at_ms INTEGER,
          duration_ms INTEGER,
          next_run_at_ms INTEGER,
          model TEXT,
          provider TEXT,
          usage_json TEXT,
          started_at INTEGER,
          finished_at INTEGER
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(job_id, status)");

      // -- Telegram channel state (replaces update-offset-*.json, sticker-cache.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_tg_state (
          account_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT,
          updated_at INTEGER,
          PRIMARY KEY (account_id, key)
        )
      `);

      // -- Discord channel state (replaces model-picker-preferences.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_dc_state (
          key TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT '',
          value_json TEXT,
          updated_at INTEGER,
          PRIMARY KEY (key, scope)
        )
      `);

      // -- Auth credentials (replaces oauth.json, github-copilot.token.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_credentials (
          provider TEXT NOT NULL,
          account_id TEXT NOT NULL DEFAULT '',
          credentials_json TEXT,
          expires_at INTEGER,
          updated_at INTEGER,
          PRIMARY KEY (provider, account_id)
        )
      `);

      // -- Exec approvals (replaces exec-approvals.json) — security-sensitive
      db.exec(`
        CREATE TABLE IF NOT EXISTS security_exec_approvals (
          approval_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'allowlist',
          pattern TEXT,
          scope TEXT,
          session_key TEXT,
          approved_by TEXT,
          last_used_at INTEGER,
          last_used_command TEXT,
          last_resolved_path TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          expires_at INTEGER
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_security_exec_approvals_agent ON security_exec_approvals(agent_id)",
      );

      // -- Workspace state (replaces {workspace}/.openclaw/workspace-state.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_state (
          workspace_id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          state_json TEXT,
          updated_at INTEGER
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_workspace_state_path ON workspace_state(workspace_path)",
      );

      // -- ClawHub catalog (replaces {workspace}/.openclaw/clawhub/catalog.json + previews)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_clawhub_catalog (
          workspace_id TEXT NOT NULL,
          skill_slug TEXT NOT NULL,
          version TEXT,
          metadata_json TEXT,
          preview_json TEXT,
          installed_at INTEGER,
          updated_at INTEGER,
          PRIMARY KEY (workspace_id, skill_slug)
        )
      `);

      // -- ClawHub locks (replaces {workspace}/.openclaw/clawhub/clawhub.lock.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_clawhub_locks (
          workspace_id TEXT NOT NULL,
          skill_slug TEXT NOT NULL,
          lock_version TEXT,
          lock_data_json TEXT,
          locked_at INTEGER,
          PRIMARY KEY (workspace_id, skill_slug)
        )
      `);
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
