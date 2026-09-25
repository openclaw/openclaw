import { expect } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";

export function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

export function createCacheExpiryIndexPhysicalDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('scope-a', 'key-a', '{}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry'`,
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
    expect(database.prepare("PRAGMA integrity_check('cache_entries')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrity_check: expect.stringMatching(/idx_agent_cache_expiry/),
        }),
      ]),
    );
  } finally {
    database.close();
  }
}

export function createTranscriptIdempotencyIndexDrift(
  databasePath: string,
  options: { duplicateRows?: boolean; hideWithCanonicalSql?: boolean } = {},
): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP INDEX idx_agent_transcript_message_idempotency;
      CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency
        ON transcript_event_identities(session_id, event_id);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:worker-1:session-1', 'session-1', '{}', 1);
      INSERT INTO session_windows (
        session_id, session_key, session_scope, created_at, updated_at
      ) VALUES (
        'session-1', 'agent:worker-1:session-1', 'conversation', 1, 1
      );
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES
        ('session-1', 1, '{}', 1),
        ('session-1', 2, '{}', 2);
      INSERT INTO transcript_event_identities (
        session_id, event_id, seq, message_idempotency_key, created_at
      ) VALUES (
        'session-1', 'event-1', 1, 'message-1', 1
      );
    `);
    if (options.duplicateRows) {
      database.exec(`
        INSERT INTO transcript_event_identities (
          session_id, event_id, seq, message_idempotency_key, created_at
        ) VALUES (
          'session-1', 'event-2', 2, 'message-1', 2
        );
      `);
    }
    if (options.hideWithCanonicalSql) {
      database.enableDefensive?.(false);
      database.exec("PRAGMA writable_schema = ON;");
      database
        .prepare(
          `UPDATE sqlite_schema
              SET sql = ?
            WHERE type = 'index'
              AND name = 'idx_agent_transcript_message_idempotency'`,
        )
        .run(
          `CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency
             ON transcript_event_identities(session_id, message_idempotency_key)
            WHERE message_idempotency_key IS NOT NULL`,
        );
      const schemaVersion = readSqliteNumberPragma(database, "schema_version");
      database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
    }
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: options.hideWithCanonicalSql
        ? expect.stringMatching(/idx_agent_transcript_message_idempotency/)
        : "ok",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
}
