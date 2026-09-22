import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";

export async function createFormatFixture(databasePath: string): Promise<void> {
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  try {
    await loadSqliteVecExtension({ db: database });
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE device_auth_tokens (
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (device_id, role)
      ) STRICT;
      CREATE TABLE channel_pairing_requests (
        channel_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        meta_json TEXT,
        PRIMARY KEY (channel_key, account_id, request_id)
      ) STRICT;
      CREATE TABLE device_pairing_join_codes (
        shortcode TEXT,
        payload_json TEXT,
        created_at_ms INTEGER,
        expires_at_ms INTEGER
      ) STRICT;
      CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        huge INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        optional TEXT
      );
      CREATE VIRTUAL TABLE content_fts USING fts5(body, content='content', content_rowid='id');
      CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
        INSERT INTO content_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2]);
      CREATE TABLE empty_table (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE session_transcript_index_state (id TEXT PRIMARY KEY, cursor INTEGER);
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
           (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)`,
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(1, "hello lobster", 9_007_199_254_740_993n, Buffer.from([0, 1, 254, 255]), "");
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(2, "second row", -9_007_199_254_740_994n, Buffer.from([42]), null);
    database.prepare("INSERT INTO session_transcript_index_state VALUES (?, ?)").run("main", 99);
    database
      .prepare(
        `INSERT INTO device_auth_tokens
           (device_id, role, token, scopes_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("device", "operator", "secret-token", "[]", 1);
    database
      .prepare(
        `INSERT INTO channel_pairing_requests
           (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("telegram", "default", "request", "pairing-code", "now", "now", null);
    database
      .prepare(
        `INSERT INTO device_pairing_join_codes
           (shortcode, payload_json, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "join-code",
        JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "bootstrap-secret" }),
        1,
        2,
      );
  } finally {
    database.close();
  }
}

export function createAgentFixture(databasePath: string, agentId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
           (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)`,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
  } finally {
    database.close();
  }
}

export async function writeBackupManifest(scopePath: string, agentId: string): Promise<void> {
  await fs.mkdir(scopePath, { recursive: true });
  await fs.writeFile(
    path.join(scopePath, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      identity: { role: "agent", agentId },
      userVersion: 1,
      excludedTables: [],
      tables: {},
    })}\n`,
  );
}
