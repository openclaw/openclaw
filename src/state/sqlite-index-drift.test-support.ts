import { expect } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { replaceNamedIndexesWithNoncanonicalIndexes } from "./sqlite-schema-shape.test-support.js";

type Database = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;
const open = (pathname: string) => new (requireNodeSqlite().DatabaseSync)(pathname);

function replaceIndexSql(database: Database, name: string, sql: string): void {
  database.enableDefensive?.(false);
  database.exec("PRAGMA writable_schema = ON;");
  database
    .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?")
    .run(sql, name);
  const version = readSqliteNumberPragma(database, "schema_version");
  database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${version + 1};`);
}

export function createUnsafeIndexDrift(databasePath: string): void {
  using database = open(databasePath);
  database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY, indexed_value TEXT NOT NULL, alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
  replaceIndexSql(
    database,
    "unsafe_index_records_value",
    "CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)",
  );
}

export function createCacheExpiryIndexPhysicalDrift(databasePath: string): void {
  using database = open(databasePath);
  database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('scope-a', 'key-a', '{}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
  replaceIndexSql(
    database,
    "idx_agent_cache_expiry",
    "CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL",
  );
  expect(database.prepare("PRAGMA integrity_check('cache_entries')").all()).toContainEqual(
    expect.objectContaining({ integrity_check: expect.stringMatching(/idx_agent_cache_expiry/) }),
  );
}

export function createTranscriptIdempotencyIndexDrift(
  databasePath: string,
  options: { duplicateRows?: boolean } = {},
): void {
  using database = open(databasePath);
  database.exec(`
      DROP INDEX idx_agent_transcript_message_idempotency;
      CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency
        ON transcript_event_identities(session_id, event_id);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:worker-1:session-1', 'session-1', '{}', 1);
      INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at)
      VALUES ('session-1', 'agent:worker-1:session-1', 'conversation', 1, 1);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('session-1', 1, '{}', 1), ('session-1', 2, '{}', 2);
      INSERT INTO transcript_event_identities (session_id, event_id, seq, message_idempotency_key, created_at)
      VALUES ('session-1', 'event-1', 1, 'message-1', 1);
    `);
  if (options.duplicateRows) {
    database.exec(`
        INSERT INTO transcript_event_identities (session_id, event_id, seq, message_idempotency_key, created_at)
        VALUES ('session-1', 'event-2', 2, 'message-1', 2);
      `);
  }
  expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

export function createCanonicalAgentIndexDrift(databasePath: string): void {
  using drifted = open(databasePath);
  drifted.exec(`
      DROP INDEX idx_agent_session_windows_session_key;
      DROP INDEX idx_agent_transcript_event_identity_sequence;
    `);
  replaceNamedIndexesWithNoncanonicalIndexes(drifted);
  drifted.exec(`
      DROP INDEX idx_agent_trajectory_runtime_run;
      CREATE INDEX idx_agent_trajectory_runtime_run
        ON trajectory_runtime_events(session_id, run_id, seq) WHERE run_id IS NOT NULL;
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:worker-1:trajectory', 'trajectory-session', '{}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('trajectory-session', 'agent:worker-1:trajectory', 1, 1);
      INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at)
        VALUES ('trajectory-session', 0, NULL, '{"type":"unassigned"}', 1),
               ('trajectory-session', 1, 'run-1', '{"type":"named"}', 2);
    `);
  expect(drifted.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(drifted.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
