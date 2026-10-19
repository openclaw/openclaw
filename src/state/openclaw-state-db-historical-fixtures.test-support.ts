import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { addPreCutoverClientCredentialTablesForTest } from "./openclaw-state-schema.test-support.js";

// Synthetic pre-v8 databases must not retain the current placement-only index.
export function markStateDatabaseVersion(database: DatabaseSync, version: number): void {
  if (
    version < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION &&
    !database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'device_identities'").get()
  ) {
    addPreCutoverClientCredentialTablesForTest(database);
  }
  database.exec(`
    ${version < 8 ? "DROP INDEX IF EXISTS idx_worker_session_placements_environment;" : ""} PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
}

export function seedV6CommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT,
      recipient_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      kind TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      suggested_text TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      confidence REAL NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      due_timezone TEXT NOT NULL,
      source_message_id TEXT,
      source_run_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER,
      sent_at_ms INTEGER,
      dismissed_at_ms INTEGER,
      snoozed_until_ms INTEGER,
      expired_at_ms INTEGER,
      record_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
    CREATE INDEX IF NOT EXISTS idx_commitments_scope_dedupe
      ON commitments(agent_id, session_key, channel, dedupe_key, status);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_due
      ON commitments(agent_id, status, due_earliest_ms, due_latest_ms, session_key);
    CREATE INDEX IF NOT EXISTS idx_commitments_agent_sent
      ON commitments(agent_id, status, sent_at_ms, session_key);
    INSERT INTO commitments (
      id, agent_id, session_key, channel, kind, sensitivity, source, status,
      reason, suggested_text, dedupe_key, confidence, due_earliest_ms,
      due_latest_ms, due_timezone, created_at_ms, updated_at_ms, attempts, record_json
    ) VALUES (
      'retired-commitment', 'main', 'agent:main:main', 'telegram', 'followup',
      'normal', 'message', 'pending', 'inert', 'follow up', 'retired-dedupe',
      1.0, 10, 20, 'UTC', 1, 1, 0, '{}'
    );
    INSERT INTO state_leases (
      scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
    ) VALUES ('test', 'preserved-lease', 'migration-test', 100, 50, '{}', 1, 2);
  `);
  markStateDatabaseVersion(database, 6);
}

export function seedEarlyCommitmentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE commitments (
      id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      due_earliest_ms INTEGER NOT NULL,
      due_latest_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX idx_commitments_scope_due
      ON commitments(agent_id, session_key, status, due_earliest_ms, due_latest_ms);
    CREATE INDEX idx_commitments_status_due
      ON commitments(status, due_earliest_ms, due_latest_ms);
  `);
}

export function createLegacyAuditStateDatabase(stateDir: string): string {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    addPreCutoverClientCredentialTablesForTest(db);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta (
        meta_key,
        role,
        schema_version,
        created_at,
        updated_at
      ) VALUES ('primary', 'global', 1, 10, 10);
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      CREATE INDEX idx_audit_events_time
        ON audit_events(occurred_at DESC, sequence DESC);
      CREATE INDEX idx_audit_events_agent_sequence
        ON audit_events(agent_id, sequence DESC);
      CREATE INDEX idx_audit_events_session_sequence
        ON audit_events(session_key, sequence DESC);
      CREATE INDEX idx_audit_events_run_sequence
        ON audit_events(run_id, sequence DESC);
      CREATE INDEX idx_audit_events_kind_sequence
        ON audit_events(kind, sequence DESC);
      CREATE INDEX idx_audit_events_status_sequence
        ON audit_events(status, sequence DESC);
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        7,
        'event-legacy',
        'run-legacy:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-legacy'
      );
      UPDATE sqlite_sequence SET seq = 40 WHERE name = 'audit_events';
    `);
  } finally {
    db.close();
  }
  return databasePath;
}
