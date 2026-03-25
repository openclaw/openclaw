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
  {
    version: 5,
    description: "Phase 5A-C: device/node pairing, sandbox registry, node-host config tables",
    up(db) {
      // -- Device pairing pending (replaces ~/.openclaw/devices/pending.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_device_pairing_pending (
          request_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_dp_pending_device ON op1_device_pairing_pending(device_id)",
      );

      // -- Device pairing paired (replaces ~/.openclaw/devices/paired.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_device_pairing_paired (
          device_id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      // -- Node pairing pending (replaces ~/.openclaw/nodes/pending.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_node_pairing_pending (
          request_id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_np_pending_node ON op1_node_pairing_pending(node_id)",
      );

      // -- Node pairing paired (replaces ~/.openclaw/nodes/paired.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_node_pairing_paired (
          node_id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      // -- Sandbox container registry (replaces ~/.openclaw/sandbox/containers.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_sandbox_containers (
          container_name TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      // -- Sandbox browser registry (replaces ~/.openclaw/sandbox/browsers.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_sandbox_browsers (
          container_name TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
    },
  },
  {
    version: 6,
    description: "Phase 6: gateway config (openclaw.json) → op1_config table",
    up(db) {
      // -- Gateway config (replaces ~/.openclaw/openclaw.json)
      // CHECK (id = 1) enforces singleton: only one config row ever exists.
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          raw_json5 TEXT NOT NULL,
          written_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
    },
  },
  {
    version: 7,
    description: "Phase 4E/5D: MCP registries, agent marketplace registries, agent locks → SQLite",
    up(db) {
      // -- MCP registries (replaces tools.mcp.registries in openclaw.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_mcp_registries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          description TEXT,
          auth_token_env TEXT,
          visibility TEXT,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )
      `);

      // -- Agent marketplace registries (replaces ~/.openclaw/agent-registry-cache/registries.json)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_agent_registries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          description TEXT,
          auth_token_env TEXT,
          visibility TEXT DEFAULT 'public',
          enabled INTEGER DEFAULT 1,
          last_synced TEXT,
          agent_count INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )
      `);

      // -- Agent locks (replaces agents-lock.yaml / agents.local-lock.yaml per scope)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_agent_locks (
          agent_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          version TEXT NOT NULL,
          resolved TEXT,
          checksum TEXT,
          installed_at TEXT,
          requires TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (agent_id, scope)
        )
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_op1_agent_locks_scope
          ON op1_agent_locks(scope)
      `);
    },
  },
  {
    version: 8,
    description: "Phase 8.5: projects registry + telegram topic bindings → SQLite",
    up(db) {
      // -- Projects registry (replaces PROJECTS.md)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          type TEXT DEFAULT '',
          tech TEXT DEFAULT '',
          status TEXT DEFAULT 'active',
          is_default INTEGER DEFAULT 0,
          keywords_json TEXT DEFAULT '[]',
          telegram_group TEXT,
          telegram_topic_id INTEGER,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_op1_projects_status ON op1_projects(status)");

      // -- Telegram topic → project bindings (extracted from PROJECTS.md telegram fields)
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_telegram_topic_bindings (
          chat_id TEXT NOT NULL,
          topic_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          group_name TEXT,
          topic_name TEXT,
          bound_at INTEGER DEFAULT (unixepoch()),
          bound_by TEXT DEFAULT 'manual',
          PRIMARY KEY (chat_id, topic_id),
          FOREIGN KEY (project_id) REFERENCES op1_projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_telegram_topic_project ON op1_telegram_topic_bindings(project_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_telegram_topic_chat ON op1_telegram_topic_bindings(chat_id)",
      );

      // -- Link workspace_state to projects (optional FK)
      // SQLite ALTER TABLE ADD COLUMN doesn't support FK constraints, so we add the column only.
      // The FK is enforced at the application level.
      try {
        db.exec("ALTER TABLE workspace_state ADD COLUMN project_id TEXT");
      } catch {
        // Column already exists (idempotent)
      }
    },
  },

  // ── v9: Audit state table + triggers for security-sensitive tables ────────
  {
    version: 9,
    description: "Phase 3: audit_state table + INSERT/UPDATE/DELETE triggers for security tables",
    up(db) {
      // Audit log table
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_key TEXT,
          action TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT,
          source TEXT DEFAULT 'gateway',
          created_at INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_state_table ON audit_state(table_name, created_at)",
      );

      // ── auth_credentials triggers ─────────────────────────────────────
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_credentials_insert
        AFTER INSERT ON auth_credentials
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, new_value)
          VALUES ('auth_credentials', NEW.provider || ':' || NEW.account_id, 'INSERT',
            json_object('provider', NEW.provider, 'account_id', NEW.account_id, 'expires_at', NEW.expires_at, 'updated_at', NEW.updated_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_credentials_update
        AFTER UPDATE ON auth_credentials
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value, new_value)
          VALUES ('auth_credentials', NEW.provider || ':' || NEW.account_id, 'UPDATE',
            json_object('provider', OLD.provider, 'account_id', OLD.account_id, 'expires_at', OLD.expires_at, 'updated_at', OLD.updated_at),
            json_object('provider', NEW.provider, 'account_id', NEW.account_id, 'expires_at', NEW.expires_at, 'updated_at', NEW.updated_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_credentials_delete
        AFTER DELETE ON auth_credentials
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value)
          VALUES ('auth_credentials', OLD.provider || ':' || OLD.account_id, 'DELETE',
            json_object('provider', OLD.provider, 'account_id', OLD.account_id, 'expires_at', OLD.expires_at, 'updated_at', OLD.updated_at));
        END
      `);

      // ── op1_auth_profiles triggers ────────────────────────────────────
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_profiles_insert
        AFTER INSERT ON op1_auth_profiles
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, new_value)
          VALUES ('op1_auth_profiles', NEW.profile_id, 'INSERT',
            json_object('profile_id', NEW.profile_id, 'type', NEW.type, 'provider', NEW.provider, 'email', NEW.email));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_profiles_update
        AFTER UPDATE ON op1_auth_profiles
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value, new_value)
          VALUES ('op1_auth_profiles', NEW.profile_id, 'UPDATE',
            json_object('profile_id', OLD.profile_id, 'type', OLD.type, 'provider', OLD.provider, 'email', OLD.email),
            json_object('profile_id', NEW.profile_id, 'type', NEW.type, 'provider', NEW.provider, 'email', NEW.email));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_auth_profiles_delete
        AFTER DELETE ON op1_auth_profiles
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value)
          VALUES ('op1_auth_profiles', OLD.profile_id, 'DELETE',
            json_object('profile_id', OLD.profile_id, 'type', OLD.type, 'provider', OLD.provider, 'email', OLD.email));
        END
      `);

      // ── op1_channel_pairing triggers ──────────────────────────────────
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_pairing_insert
        AFTER INSERT ON op1_channel_pairing
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, new_value)
          VALUES ('op1_channel_pairing', NEW.channel || ':' || NEW.account_id || ':' || NEW.sender_id, 'INSERT',
            json_object('channel', NEW.channel, 'account_id', NEW.account_id, 'sender_id', NEW.sender_id, 'created_at', NEW.created_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_pairing_update
        AFTER UPDATE ON op1_channel_pairing
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value, new_value)
          VALUES ('op1_channel_pairing', NEW.channel || ':' || NEW.account_id || ':' || NEW.sender_id, 'UPDATE',
            json_object('channel', OLD.channel, 'account_id', OLD.account_id, 'sender_id', OLD.sender_id, 'created_at', OLD.created_at),
            json_object('channel', NEW.channel, 'account_id', NEW.account_id, 'sender_id', NEW.sender_id, 'created_at', NEW.created_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_pairing_delete
        AFTER DELETE ON op1_channel_pairing
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value)
          VALUES ('op1_channel_pairing', OLD.channel || ':' || OLD.account_id || ':' || OLD.sender_id, 'DELETE',
            json_object('channel', OLD.channel, 'account_id', OLD.account_id, 'sender_id', OLD.sender_id, 'created_at', OLD.created_at));
        END
      `);

      // ── op1_channel_allowlist triggers ────────────────────────────────
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_allowlist_insert
        AFTER INSERT ON op1_channel_allowlist
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, new_value)
          VALUES ('op1_channel_allowlist', NEW.channel || ':' || NEW.account_id || ':' || NEW.sender_id, 'INSERT',
            json_object('channel', NEW.channel, 'account_id', NEW.account_id, 'sender_id', NEW.sender_id, 'added_at', NEW.added_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_allowlist_update
        AFTER UPDATE ON op1_channel_allowlist
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value, new_value)
          VALUES ('op1_channel_allowlist', NEW.channel || ':' || NEW.account_id || ':' || NEW.sender_id, 'UPDATE',
            json_object('channel', OLD.channel, 'account_id', OLD.account_id, 'sender_id', OLD.sender_id, 'added_at', OLD.added_at),
            json_object('channel', NEW.channel, 'account_id', NEW.account_id, 'sender_id', NEW.sender_id, 'added_at', NEW.added_at));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_channel_allowlist_delete
        AFTER DELETE ON op1_channel_allowlist
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value)
          VALUES ('op1_channel_allowlist', OLD.channel || ':' || OLD.account_id || ':' || OLD.sender_id, 'DELETE',
            json_object('channel', OLD.channel, 'account_id', OLD.account_id, 'sender_id', OLD.sender_id, 'added_at', OLD.added_at));
        END
      `);

      // ── security_exec_approvals triggers ──────────────────────────────
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_exec_approvals_insert
        AFTER INSERT ON security_exec_approvals
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, new_value)
          VALUES ('security_exec_approvals', NEW.approval_id, 'INSERT',
            json_object('approval_id', NEW.approval_id, 'agent_id', NEW.agent_id, 'kind', NEW.kind, 'pattern', NEW.pattern, 'scope', NEW.scope, 'approved_by', NEW.approved_by));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_exec_approvals_update
        AFTER UPDATE ON security_exec_approvals
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value, new_value)
          VALUES ('security_exec_approvals', NEW.approval_id, 'UPDATE',
            json_object('approval_id', OLD.approval_id, 'agent_id', OLD.agent_id, 'kind', OLD.kind, 'pattern', OLD.pattern, 'scope', OLD.scope, 'approved_by', OLD.approved_by),
            json_object('approval_id', NEW.approval_id, 'agent_id', NEW.agent_id, 'kind', NEW.kind, 'pattern', NEW.pattern, 'scope', NEW.scope, 'approved_by', NEW.approved_by));
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_exec_approvals_delete
        AFTER DELETE ON security_exec_approvals
        BEGIN
          INSERT INTO audit_state (table_name, record_key, action, old_value)
          VALUES ('security_exec_approvals', OLD.approval_id, 'DELETE',
            json_object('approval_id', OLD.approval_id, 'agent_id', OLD.agent_id, 'kind', OLD.kind, 'pattern', OLD.pattern, 'scope', OLD.scope, 'approved_by', OLD.approved_by));
        END
      `);
    },
  },

  // ── v11: Slash commands registry + invocation log ────────────────────────
  {
    version: 11,
    description: "Slash commands: op1_commands registry and op1_command_invocations log",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_commands (
          command_id   TEXT PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          description  TEXT NOT NULL,
          emoji        TEXT,
          file_path    TEXT,
          type         TEXT NOT NULL DEFAULT 'command',
          source       TEXT NOT NULL DEFAULT 'user',
          user_command INTEGER NOT NULL DEFAULT 1,
          model_invocation INTEGER NOT NULL DEFAULT 0,
          enabled      INTEGER NOT NULL DEFAULT 1,
          long_running INTEGER NOT NULL DEFAULT 0,
          args_json    TEXT,
          tags_json    TEXT,
          category     TEXT NOT NULL DEFAULT 'general',
          version      INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER DEFAULT (unixepoch()),
          updated_at   INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_command_invocations (
          invocation_id        TEXT PRIMARY KEY,
          command_id           TEXT NOT NULL,
          command_name         TEXT NOT NULL,
          invoked_by           TEXT,
          args_json            TEXT,
          original_message     TEXT,
          expanded_instruction TEXT,
          session_key          TEXT,
          success              INTEGER,
          error_message        TEXT,
          executed_at          INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_op1_commands_name ON op1_commands(name)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_command_invocations_command_id ON op1_command_invocations(command_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_command_invocations_session ON op1_command_invocations(session_key)",
      );

      // Seed built-in commands (source='builtin' — read-only via CRUD)
      const seedInsert = db.prepare(`
        INSERT OR IGNORE INTO op1_commands
          (command_id, name, description, emoji, file_path, type, source,
           user_command, model_invocation, long_running, args_json, category)
        VALUES (?, ?, ?, ?, ?, 'command', 'builtin', 1, 0, ?, ?, ?)
      `);
      const seeds: Array<{
        id: string;
        name: string;
        desc: string;
        emoji: string;
        longRunning: number;
        argsJson: string | null;
        category: string;
      }> = [
        {
          id: "00000000-0000-0000-0000-000000000001",
          name: "status",
          desc: "Check gateway and channel connection status",
          emoji: "📡",
          longRunning: 0,
          argsJson: null,
          category: "system",
        },
        {
          id: "00000000-0000-0000-0000-000000000002",
          name: "agents",
          desc: "List all active agents and their current status",
          emoji: "🤖",
          longRunning: 0,
          argsJson: null,
          category: "system",
        },
        {
          id: "00000000-0000-0000-0000-000000000003",
          name: "logs",
          desc: "Show recent gateway logs",
          emoji: "📋",
          longRunning: 0,
          argsJson: JSON.stringify([
            { name: "lines", type: "number", required: false, default: "30" },
          ]),
          category: "system",
        },
        {
          id: "00000000-0000-0000-0000-000000000004",
          name: "build",
          desc: "Run project build",
          emoji: "🔨",
          longRunning: 1,
          argsJson: JSON.stringify([
            { name: "project", type: "string", required: false, default: "." },
          ]),
          category: "build",
        },
        {
          id: "00000000-0000-0000-0000-000000000005",
          name: "help",
          desc: "List all available slash commands",
          emoji: "❓",
          longRunning: 0,
          argsJson: null,
          category: "general",
        },
      ];
      for (const s of seeds) {
        // file_path is null — builtins read their body from seeds dir at runtime
        seedInsert.run(s.id, s.name, s.desc, s.emoji, null, s.longRunning, s.argsJson, s.category);
      }
    },
  },

  // ── v10: Promote project_id on session_entries ────────────────────────────
  {
    version: 10,
    description: "Phase 8A: add project_id column to session_entries (was in extra_json)",
    up(db) {
      try {
        db.exec("ALTER TABLE session_entries ADD COLUMN project_id TEXT");
      } catch {
        // Column already exists (idempotent)
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_session_entries_project ON session_entries(project_id)",
      );

      // Migrate existing projectId values from extra_json → dedicated column
      const rows = db
        .prepare(
          "SELECT agent_id, session_key, extra_json FROM session_entries WHERE extra_json IS NOT NULL",
        )
        .all() as Array<{ agent_id: string; session_key: string; extra_json: string }>;

      const update = db.prepare(
        "UPDATE session_entries SET project_id = ?, extra_json = ? WHERE agent_id = ? AND session_key = ?",
      );

      for (const row of rows) {
        try {
          const extra = JSON.parse(row.extra_json) as Record<string, unknown>;
          if (typeof extra.projectId === "string") {
            const projectId = extra.projectId;
            delete extra.projectId;
            const newExtra = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
            update.run(projectId, newExtra, row.agent_id, row.session_key);
          }
        } catch {
          // Corrupt JSON — skip
        }
      }
    },
  },

  // ── v12: Memory activity log table ──────────────────────────────────────
  {
    version: 12,
    description: "Memory activity log — replaces JSONL scanning with indexed SQLite table",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_memory_activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          tool_name TEXT,
          file_path TEXT,
          query TEXT,
          snippet TEXT,
          session_file TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_memory_activity_agent ON op1_memory_activity(agent_id, created_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_op1_memory_activity_op ON op1_memory_activity(operation)",
      );
    },
  },

  // ── v13: Generic KV settings table ──────────────────────────────────────
  {
    version: 13,
    description: "Generic op1_settings KV table — replaces agent-managed heartbeat-state.json",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_settings (
          scope      TEXT NOT NULL,
          key        TEXT NOT NULL DEFAULT '',
          value_json TEXT NOT NULL DEFAULT '""',
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (scope, key)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_op1_settings_scope ON op1_settings(scope)");
    },
  },
  // ── v14: Add /plan built-in command ──────────────────────────────────────
  {
    version: 14,
    description: "Add /plan built-in command for step-by-step planning before execution",
    up(db) {
      const planBody = [
        "Before executing, first create a step-by-step plan as a markdown task list. Use this exact format:",
        "",
        "- [ ] Step 1 description",
        "- [ ] Step 2 description",
        "- [ ] Step 3 description",
        "",
        "Then execute each step one by one. After completing each step, re-output the FULL plan with completed steps marked as `- [x]` and remaining steps as `- [ ]`.",
        "",
        "Task: {{task}}",
      ].join("\n");
      db.prepare(`
        INSERT OR IGNORE INTO op1_commands
          (command_id, name, description, emoji, file_path, type, source,
           user_command, model_invocation, long_running, args_json, category)
        VALUES (?, ?, ?, ?, NULL, 'command', 'builtin', 1, 0, 0, ?, ?)
      `).run(
        "00000000-0000-0000-0000-000000000006",
        "plan",
        planBody,
        "📋",
        JSON.stringify([{ name: "task", type: "string", required: true }]),
        "general",
      );
    },
  },

  // ── v15: Operator1Hub catalog, installed tracking, and collections ─────────
  {
    version: 15,
    description: "Operator1Hub: op1_hub_catalog, op1_hub_installed, op1_hub_collections tables",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_hub_catalog (
          slug        TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL CHECK (type IN ('skill', 'agent', 'command')),
          category    TEXT NOT NULL,
          description TEXT,
          path        TEXT NOT NULL,
          readme      TEXT,
          version     TEXT NOT NULL,
          tags_json   TEXT NOT NULL DEFAULT '[]',
          emoji       TEXT,
          sha256      TEXT,
          bundled     INTEGER NOT NULL DEFAULT 0,
          synced_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS op1_hub_installed (
          slug          TEXT PRIMARY KEY,
          type          TEXT NOT NULL,
          version       TEXT NOT NULL,
          install_path  TEXT NOT NULL,
          agent_id      TEXT,
          installed_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS op1_hub_collections (
          slug        TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          emoji       TEXT,
          items_json  TEXT NOT NULL DEFAULT '[]'
        );
      `);
    },
  },

  // ── v16: Hub MCP support — add config_json, drop type CHECK constraint ──────
  {
    version: 16,
    description: "Hub: add config_json column to op1_hub_catalog, allow 'mcp' type",
    up(db) {
      // Recreate table without the CHECK constraint on type, adding config_json column.
      // Hub catalog is fully replaced on every sync so data loss is acceptable.
      db.exec(`
        CREATE TABLE op1_hub_catalog_v16 (
          slug        TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL,
          category    TEXT NOT NULL,
          description TEXT,
          path        TEXT NOT NULL,
          readme      TEXT,
          version     TEXT NOT NULL,
          tags_json   TEXT NOT NULL DEFAULT '[]',
          emoji       TEXT,
          sha256      TEXT,
          bundled     INTEGER NOT NULL DEFAULT 0,
          config_json TEXT,
          synced_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO op1_hub_catalog_v16
          SELECT slug, name, type, category, description, path, readme, version,
                 tags_json, emoji, sha256, bundled, NULL, synced_at
          FROM op1_hub_catalog;
        DROP TABLE op1_hub_catalog;
        ALTER TABLE op1_hub_catalog_v16 RENAME TO op1_hub_catalog;
      `);
    },
  },

  // ── v17: Onboarding wizard state ──────────────────────────────────────────
  {
    version: 17,
    description: "Onboarding wizard state",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_onboarding (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          status TEXT NOT NULL DEFAULT 'pending',
          current_step INTEGER NOT NULL DEFAULT 1,
          steps_completed_json TEXT DEFAULT '[]',
          steps_skipped_json TEXT DEFAULT '[]',
          config_snapshot_json TEXT DEFAULT '{}',
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER DEFAULT (unixepoch())
        )
      `);
      // Seed the singleton row
      db.exec(`
        INSERT OR IGNORE INTO op1_onboarding (id, status, current_step)
        VALUES (1, 'pending', 1)
      `);
    },
  },

  // ── v18: Workspaces ───────────────────────────────────────────────────────
  {
    version: 18,
    description:
      "Workspaces: op1_workspaces, op1_workspace_agents, add workspace_id to op1_projects",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_workspaces (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT,
          status        TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'archived', 'suspended')),
          task_prefix   TEXT NOT NULL DEFAULT 'OP1',
          task_counter  INTEGER NOT NULL DEFAULT 0,
          budget_monthly_microcents INTEGER,
          spent_monthly_microcents  INTEGER NOT NULL DEFAULT 0,
          brand_color   TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_workspace_agents (
          workspace_id  TEXT NOT NULL,
          agent_id      TEXT NOT NULL,
          role          TEXT,
          joined_at     INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (workspace_id, agent_id),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_ws_agents_agent ON op1_workspace_agents(agent_id)");

      // Seed default workspace
      db.exec(`
        INSERT OR IGNORE INTO op1_workspaces (id, name, description, task_prefix)
        VALUES ('default', 'Default Workspace', 'Auto-created default workspace', 'OP1')
      `);

      // Add workspace_id to existing projects table
      try {
        db.exec(
          "ALTER TABLE op1_projects ADD COLUMN workspace_id TEXT REFERENCES op1_workspaces(id)",
        );
      } catch {
        // Column exists
      }
      db.exec("UPDATE op1_projects SET workspace_id = 'default' WHERE workspace_id IS NULL");
    },
  },

  // ── v19: Tasks and Task Comments ──────────────────────────────────────────
  {
    version: 19,
    description: "Task System: op1_tasks, op1_task_comments",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_tasks (
          id              TEXT PRIMARY KEY,
          workspace_id    TEXT NOT NULL,
          project_id      TEXT,
          goal_id         TEXT,
          parent_id       TEXT,
          identifier      TEXT NOT NULL,
          title           TEXT NOT NULL,
          description     TEXT,
          status          TEXT NOT NULL DEFAULT 'backlog'
                          CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','cancelled')),
          priority        TEXT NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low','medium','high','critical')),
          assignee_agent_id TEXT,
          billing_code    TEXT,
          created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at    INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES op1_tasks(id) ON DELETE SET NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON op1_tasks(workspace_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON op1_tasks(assignee_agent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON op1_tasks(project_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_goal ON op1_tasks(goal_id)");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_identifier ON op1_tasks(workspace_id, identifier)",
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_task_comments (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          author_id     TEXT NOT NULL,
          author_type   TEXT NOT NULL DEFAULT 'agent'
                        CHECK (author_type IN ('agent', 'user', 'system')),
          body          TEXT NOT NULL,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES op1_tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_comments_task ON op1_task_comments(task_id, created_at)",
      );
    },
  },

  // ── v20: Goals ────────────────────────────────────────────────────────────
  {
    version: 20,
    description: "Goals Hierarchy: op1_goals",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_goals (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          parent_id     TEXT,
          title         TEXT NOT NULL,
          description   TEXT,
          level         TEXT NOT NULL DEFAULT 'objective'
                        CHECK (level IN ('vision','objective','key_result')),
          status        TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','in_progress','achieved','abandoned')),
          owner_agent_id TEXT,
          progress      INTEGER DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES op1_goals(id) ON DELETE SET NULL
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_goals_workspace ON op1_goals(workspace_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_goals_parent ON op1_goals(parent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_goals_owner ON op1_goals(owner_agent_id)");
    },
  },

  // ── v21: Cost Events and Budget Policies ──────────────────────────────────
  {
    version: 21,
    description:
      "Cost tracking and budgets: op1_cost_events, op1_budget_policies, op1_budget_incidents",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_cost_events (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          agent_id      TEXT NOT NULL,
          session_id    TEXT,
          task_id       TEXT,
          project_id    TEXT,
          provider      TEXT,
          model         TEXT,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_microcents INTEGER NOT NULL DEFAULT 0,
          occurred_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_cost_events_workspace ON op1_cost_events(workspace_id, occurred_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON op1_cost_events(agent_id, occurred_at)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_cost_events_project ON op1_cost_events(project_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_cost_events_task ON op1_cost_events(task_id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_budget_policies (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          scope_type    TEXT NOT NULL CHECK (scope_type IN ('workspace','agent','project')),
          scope_id      TEXT NOT NULL,
          amount_microcents INTEGER NOT NULL,
          window_kind   TEXT NOT NULL DEFAULT 'calendar_month_utc'
                        CHECK (window_kind IN ('calendar_month_utc','lifetime')),
          warn_percent  INTEGER NOT NULL DEFAULT 80,
          hard_stop     INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_budget_policies_scope ON op1_budget_policies(scope_type, scope_id)",
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_budget_incidents (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          policy_id     TEXT NOT NULL,
          type          TEXT NOT NULL CHECK (type IN ('warning','hard_stop','resolved')),
          agent_id      TEXT,
          spent_microcents INTEGER NOT NULL,
          limit_microcents INTEGER NOT NULL,
          message       TEXT,
          resolved_at   INTEGER,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (policy_id) REFERENCES op1_budget_policies(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_budget_incidents_workspace ON op1_budget_incidents(workspace_id, created_at)",
      );
    },
  },

  // ── v22: Approvals and Activity Log ───────────────────────────────────────
  {
    version: 22,
    description: "Governance: op1_approvals, op1_activity_log",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_approvals (
          id              TEXT PRIMARY KEY,
          workspace_id    TEXT NOT NULL,
          type            TEXT NOT NULL CHECK (type IN ('agent_hire','budget_override','config_change')),
          status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','revision_requested','approved','rejected')),
          requester_id    TEXT NOT NULL,
          requester_type  TEXT NOT NULL DEFAULT 'agent'
                          CHECK (requester_type IN ('agent','user','system')),
          payload_json    TEXT,
          decision_note   TEXT,
          decided_by      TEXT,
          decided_at      INTEGER,
          created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON op1_approvals(workspace_id, status)",
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_activity_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id  TEXT NOT NULL,
          actor_type    TEXT NOT NULL DEFAULT 'system'
                        CHECK (actor_type IN ('user','agent','system')),
          actor_id      TEXT,
          action        TEXT NOT NULL,
          entity_type   TEXT,
          entity_id     TEXT,
          details_json  TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_activity_log_workspace ON op1_activity_log(workspace_id, created_at)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON op1_activity_log(entity_type, entity_id)",
      );
    },
  },

  // ── v23: Agent Config Revisions ───────────────────────────────────────────
  {
    version: 23,
    description: "Agent config tracking: op1_agent_config_revisions",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_agent_config_revisions (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL,
          agent_id      TEXT NOT NULL,
          config_json   TEXT NOT NULL,
          changed_by    TEXT,
          change_note   TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_config_revisions ON op1_agent_config_revisions(agent_id, created_at)",
      );
    },
  },

  // ── v24: Agent Status Tracking ────────────────────────────────────────────
  {
    version: 24,
    description: "Agent status tracking: op1_workspace_agents columns",
    up(db) {
      try {
        db.exec(
          "ALTER TABLE op1_workspace_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        );
      } catch {
        // Ignore if exists
      }
      try {
        db.exec("ALTER TABLE op1_workspace_agents ADD COLUMN capabilities_json TEXT");
      } catch {
        // Ignore if exists
      }
    },
  },

  // ── v26: Agent API Keys ────────────────────────────────────────────────────
  {
    version: 26,
    description: "Agent API keys: op1_agent_api_keys",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_agent_api_keys (
          id            TEXT PRIMARY KEY,
          agent_id      TEXT NOT NULL,
          workspace_id  TEXT NOT NULL DEFAULT 'default',
          name          TEXT NOT NULL,
          key_hash      TEXT NOT NULL,
          key_prefix    TEXT NOT NULL,
          last_used_at  INTEGER,
          revoked_at    INTEGER,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_agent_api_keys_hash ON op1_agent_api_keys(key_hash)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON op1_agent_api_keys(agent_id)",
      );
    },
  },

  // ── v27: Execution Workspaces ──────────────────────────────────────────────
  {
    version: 27,
    description: "Execution workspaces: op1_execution_workspaces + op1_workspace_operations",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_execution_workspaces (
          id                TEXT PRIMARY KEY,
          workspace_id      TEXT NOT NULL DEFAULT 'default',
          project_id        TEXT,
          task_id           TEXT,
          agent_id          TEXT,
          name              TEXT NOT NULL,
          mode              TEXT NOT NULL DEFAULT 'local_fs',
          status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'cleanup_pending')),
          workspace_path    TEXT,
          base_ref          TEXT,
          branch_name       TEXT,
          opened_at         INTEGER NOT NULL DEFAULT (unixepoch()),
          closed_at         INTEGER,
          metadata_json     TEXT,
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_exec_ws_workspace ON op1_execution_workspaces(workspace_id)",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_exec_ws_task ON op1_execution_workspaces(task_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_exec_ws_agent ON op1_execution_workspaces(agent_id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_workspace_operations (
          id                     TEXT PRIMARY KEY,
          execution_workspace_id TEXT NOT NULL,
          operation_type         TEXT NOT NULL,
          status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
          details_json           TEXT,
          started_at             INTEGER NOT NULL DEFAULT (unixepoch()),
          completed_at           INTEGER,
          FOREIGN KEY (execution_workspace_id) REFERENCES op1_execution_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ws_ops_exec_ws ON op1_workspace_operations(execution_workspace_id)",
      );
    },
  },

  // ── v28: Task documents + attachments ─────────────────────────────────────
  {
    version: 28,
    description: "Task documents and attachments: op1_task_documents + op1_task_attachments",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_task_documents (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          title         TEXT,
          format        TEXT NOT NULL DEFAULT 'markdown',
          body          TEXT NOT NULL DEFAULT '',
          created_by    TEXT,
          updated_by    TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES op1_tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_documents_task ON op1_task_documents(task_id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_task_attachments (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          filename      TEXT NOT NULL,
          mime_type     TEXT,
          size_bytes    INTEGER,
          storage_path  TEXT NOT NULL,
          created_by    TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (task_id) REFERENCES op1_tasks(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON op1_task_attachments(task_id)",
      );
    },
  },

  // ── v29: Finance events ────────────────────────────────────────────────────
  {
    version: 29,
    description: "Finance events: op1_finance_events",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_finance_events (
          id                TEXT PRIMARY KEY,
          workspace_id      TEXT NOT NULL,
          agent_id          TEXT,
          task_id           TEXT,
          project_id        TEXT,
          goal_id           TEXT,
          cost_event_id     TEXT,
          billing_code      TEXT,
          description       TEXT,
          event_kind        TEXT NOT NULL,
          direction         TEXT NOT NULL DEFAULT 'debit',
          provider          TEXT,
          model             TEXT,
          amount_microcents INTEGER NOT NULL DEFAULT 0,
          created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_finance_events_workspace ON op1_finance_events(workspace_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_finance_events_agent ON op1_finance_events(agent_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_finance_events_created ON op1_finance_events(created_at)",
      );
    },
  },
  {
    version: 30,
    description: "Agent wakeup requests: op1_agent_wakeup_requests",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_agent_wakeup_requests (
          id            TEXT PRIMARY KEY,
          workspace_id  TEXT NOT NULL DEFAULT 'default',
          agent_id      TEXT NOT NULL,
          task_id       TEXT,
          reason        TEXT NOT NULL DEFAULT 'task_assigned',
          status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
          payload_json  TEXT,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          processed_at  INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES op1_workspaces(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_wakeup_requests_agent ON op1_agent_wakeup_requests(agent_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_wakeup_requests_status ON op1_agent_wakeup_requests(status)",
      );
    },
  },

  // ── v31: Approval comment threads ─────────────────────────────────────────
  {
    version: 31,
    description: "Approval comment threads: op1_approval_comments",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_approval_comments (
          id            TEXT PRIMARY KEY,
          approval_id   TEXT NOT NULL,
          author_id     TEXT NOT NULL,
          author_type   TEXT NOT NULL DEFAULT 'user' CHECK (author_type IN ('agent', 'user', 'system')),
          body          TEXT NOT NULL,
          created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (approval_id) REFERENCES op1_approvals(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON op1_approval_comments(approval_id)",
      );
    },
  },
  {
    version: 32,
    description: "Delegation tracker: index on op1_subagent_runs for active delegation lookup",
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_active
          ON op1_subagent_runs(requester_session_key)
      `);
      // Note: SQLite doesn't support partial indexes with WHERE in all cases,
      // so we use a full index and filter in queries
    },
  },

  // ── v33: MCP Servers ───────────────────────────────────────────────────────
  {
    version: 33,
    description: "MCP servers: op1_mcp_servers (replaces ~/.openclaw/mcp/servers.yaml)",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS op1_mcp_servers (
          key         TEXT NOT NULL,
          scope       TEXT NOT NULL,
          type        TEXT NOT NULL,
          config_json TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (key, scope)
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON op1_mcp_servers(scope)",
      );

      // Best-effort auto-import from ~/.openclaw/mcp/servers.yaml (user scope only).
      // Uses dynamic require to avoid a hard dependency at module load time.
      try {
        const { readFileSync } = require("node:fs");
        const { homedir } = require("node:os");
        const { join } = require("node:path");
        const { parse: parseYaml } = require("yaml");

        const yamlPath = join(homedir(), ".openclaw", "mcp", "servers.yaml");
        let raw: string;
        try {
          raw = readFileSync(yamlPath, "utf-8") as string;
        } catch {
          // File doesn't exist — nothing to import.
          return;
        }

        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object") return;

        const insert = db.prepare(
          `INSERT OR IGNORE INTO op1_mcp_servers (key, scope, type, config_json, enabled)
           VALUES (?, 'user', ?, ?, ?)`,
        );
        for (const [key, value] of Object.entries(parsed)) {
          if (!value || typeof value !== "object" || !("type" in value)) continue;
          const cfg = value as Record<string, unknown>;
          const type = typeof cfg["type"] === "string" ? cfg["type"] : "stdio";
          const enabled = cfg["enabled"] !== false ? 1 : 0;
          insert.run(key, type, JSON.stringify(cfg), enabled);
        }
      } catch {
        // Best-effort: never crash the migration if YAML import fails.
      }
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
