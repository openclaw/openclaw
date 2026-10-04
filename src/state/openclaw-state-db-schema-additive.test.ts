import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { ensureMeetingTranscriptsSchema } from "../transcripts/sqlite-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

const trailingSchema = vi.hoisted(() => ({
  tableName: "future_lazy_state",
  sql: "CREATE TABLE IF NOT EXISTS future_lazy_state (id TEXT PRIMARY KEY) STRICT;",
}));

vi.mock("./openclaw-state-schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-schema.js")>();
  return {
    ...actual,
    OPENCLAW_STATE_SCHEMA_SQL: `${actual.OPENCLAW_STATE_SCHEMA_SQL}\n${trailingSchema.sql}\n`,
  };
});

import {
  ensureAgentDatabaseLeaseSchema,
  ensureSecretStoreSchema,
} from "./openclaw-state-db-schema-additive.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

it("keeps secret-store first use from installing later additive schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    ensureSecretStoreSchema(database);
    const names = database
      .prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?) ORDER BY name")
      .all("secret_store_entries", "secret_store_entries_live_idx", trailingSchema.tableName)
      .map((row) => row.name);

    expect(names).toEqual(["secret_store_entries", "secret_store_entries_live_idx"]);
  } finally {
    database.close();
  }
});

it("lazily adds allowed_hosts to a v6 secret store without changing user_version", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA user_version = 6;
      CREATE TABLE secret_store_entries (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        updated_by TEXT,
        deleted_at_ms INTEGER,
        PRIMARY KEY (scope_kind, scope_id, name)
      ) STRICT;
    `);

    ensureSecretStoreSchema(database);

    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(
      database
        .prepare(
          'SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?) WHERE name = ?',
        )
        .get("secret_store_entries", "allowed_hosts"),
    ).toEqual({ name: "allowed_hosts", type: "TEXT", notnull: 0, dflt_value: null });
  } finally {
    database.close();
  }
});

it("adds lease provenance without certifying legacy owners or changing their identifiers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA user_version = 6;
      CREATE TABLE agent_database_leases (
        lease_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        path TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_start_time INTEGER,
        opened_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO agent_database_leases VALUES ('abc-123', 'main', '/agent.sqlite', 123, 456, 789);
    `);
    const before = database.prepare("SELECT * FROM agent_database_leases").get();

    database.exec("BEGIN");
    ensureAgentDatabaseLeaseSchema(database);
    database.exec("ROLLBACK");
    expect(database.prepare("SELECT * FROM agent_database_leases").get()).toEqual(before);

    ensureAgentDatabaseLeaseSchema(database);
    expect(database.prepare("SELECT * FROM agent_database_leases").get()).toEqual({
      ...before,
      provenance: null,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  } finally {
    database.close();
  }
});

it("adds the caption retry index to populated same-version state without changing its rows", async () => {
  const options = {
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-caption-index-") },
  };
  const database = openOpenClawStateDatabase(options);
  database.db.exec(`
    INSERT INTO meeting_transcript_sessions
      (session_id, started_at, selector, export_key, session_slug, provider_id,
       source_json, next_utterance_seq, created_at_ms, updated_at_ms)
    VALUES ('meeting', 'start', 'meeting@start', 'meeting', 'meeting', 'manual-transcript',
            '{"providerId":"manual-transcript"}', 3, 1, 1);
    INSERT INTO meeting_transcript_utterances
      (session_id, session_started_at, sequence, utterance_id, text, final)
    VALUES ('meeting', 'start', 0, 'caption', 'Draft caption', 0),
           ('meeting', 'start', 1, 'caption', 'Final caption', 1),
           ('meeting', 'start', 2, NULL, 'Unidentified caption', NULL);
  `);
  const readState = (db: DatabaseSync) => ({
    sessions: db.prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id").all(),
    utterances: db.prepare("SELECT * FROM meeting_transcript_utterances ORDER BY sequence").all(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    version: db.prepare("PRAGMA user_version").get(),
  });
  const before = readState(database.db);
  expect(before.version).toEqual({ user_version: OPENCLAW_STATE_SCHEMA_VERSION });
  const indexName = "idx_meeting_transcript_utterances_id";
  const readIndex = (db: DatabaseSync) =>
    db
      .prepare('SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?')
      .get("meeting_transcript_utterances", indexName);
  const previousSchema = getOpenClawStateRuntimeSchema({
    includeVersionLazyAdditiveTables: false,
  }).replace(/CREATE INDEX IF NOT EXISTS idx_meeting_transcript_utterances_id\b[^;]*;/u, "");
  expect(() =>
    assertSqliteSchemaContains(
      database.db,
      database.path,
      previousSchema,
      OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
    ),
  ).not.toThrow();

  await closeStateDatabaseForTest();
  const previous = new DatabaseSync(database.path);
  try {
    previous.exec(`DROP INDEX IF EXISTS ${indexName}`);
  } finally {
    previous.close();
  }
  const reader = await openExistingOpenClawStateDatabaseReadOnly(options);
  assert(reader);
  try {
    expect(readState(reader.db)).toEqual(before);
    expect(readIndex(reader.db)).toBeUndefined();
  } finally {
    reader.walMaintenance.close();
  }

  const repaired = openOpenClawStateDatabase(options);
  expect(readState(repaired.db)).toEqual(before);
  expect(readIndex(repaired.db)).toEqual({ unique: 0, partial: 1 });
  expect(
    repaired.db
      .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(indexName)
      .map((row) => row.name),
  ).toEqual(["session_id", "session_started_at", "utterance_id"]);
  const schemaCookie = repaired.db.prepare("PRAGMA schema_version").get();
  await closeStateDatabaseForTest();
  const reopened = openOpenClawStateDatabase(options);
  expect(readState(reopened.db)).toEqual(before);
  expect(reopened.db.prepare("PRAGMA schema_version").get()).toEqual(schemaCookie);

  // A retained handle's first feature use must include the index in its canonical DDL block.
  reopened.db.exec(`DROP INDEX ${indexName}`);
  ensureMeetingTranscriptsSchema({ ...options, database: reopened });
  expect(readIndex(reopened.db)).toEqual({ unique: 0, partial: 1 });
  expect(readState(reopened.db)).toEqual(before);
});
