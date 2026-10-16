import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ensureMemoryChunkProvenance } from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import { ensureMemoryEntryOriginsSchema } from "../../packages/memory-host-sdk/src/memory-entry-origins.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureExecutionOwnerLifecycleBindingSchema } from "../audit/execution-owner-lifecycle-binding-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "../infra/sqlite-schema-facts.test-support.js";
import { classifySqliteMutation } from "../infra/sqlite-schema-mutation.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { ensureMeetingTranscriptsSchema } from "../transcripts/sqlite-schema.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "./openclaw-agent-board-schema.js";
import { ensureSessionGoalOperationsSchema } from "./openclaw-agent-goal-operations-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  assertAgentDeletionJournalAvailable,
  ensureAgentDatabaseLeaseSchema,
  ensureSecretStoreSchema,
} from "./openclaw-state-db-schema-additive.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

const { openDatabase } = useSqliteSchemaTestFixture();

it.each([
  {
    name: "audit lifecycle binding",
    schema: OPENCLAW_STATE_SCHEMA_SQL,
    ensure: ensureExecutionOwnerLifecycleBindingSchema,
  },
  {
    name: "goal receipt",
    schema: OPENCLAW_AGENT_SCHEMA_SQL,
    ensure: ensureSessionGoalOperationsSchema,
  },
  {
    name: "board",
    schema: OPENCLAW_AGENT_SCHEMA_SQL,
    ensure: ensureOpenClawAgentBoardSchemaInTransaction,
  },
  {
    name: "memory origin",
    schema: OPENCLAW_AGENT_SCHEMA_SQL,
    ensure: ensureMemoryEntryOriginsSchema,
  },
  {
    name: "memory provenance",
    schema: OPENCLAW_AGENT_SCHEMA_SQL,
    ensure: ensureMemoryChunkProvenance,
  },
])("never issues persistent DDL on first or repeated warm $name use", ({ schema, ensure }) => {
  const database = openDatabase(schema);
  const observation = observeHostDataSql();
  try {
    for (let call = 0; call < 2; call += 1) {
      database.exec("BEGIN IMMEDIATE");
      ensure(database);
      database.exec("COMMIT");
    }
    expect(
      observation.queries.filter((sql) => classifySqliteMutation(sql, "batch").mainSchemaChange),
    ).toEqual([]);
  } finally {
    observation.restore();
  }
});

it("installs only the secret-store table and index on first use", () => {
  const database = new DatabaseSync(":memory:");
  try {
    ensureSecretStoreSchema(database);
    const names = database
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
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
  const readState = (db: EngineConnection) => ({
    sessions: db.prepare("SELECT * FROM meeting_transcript_sessions ORDER BY session_id").all(),
    utterances: db.prepare("SELECT * FROM meeting_transcript_utterances ORDER BY sequence").all(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    version: db.prepare("PRAGMA user_version").get(),
  });
  const before = readState(database.db);
  expect(before.version).toEqual({ user_version: OPENCLAW_STATE_SCHEMA_VERSION });
  const indexName = "idx_meeting_transcript_utterances_id";
  const readIndex = (db: EngineConnection) =>
    db
      .prepare('SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?')
      .get("meeting_transcript_utterances", indexName);
  const previousSchema = getOpenClawStateRuntimeSchema({
    includeVersionLazyAdditiveTables: false,
  }).replace(/CREATE INDEX IF NOT EXISTS idx_meeting_transcript_utterances_id\b[^;]*;/u, "");
  expect(() =>
    assertSqliteSchemaContains(
      requireNativeSqliteDatabase(database.db),
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

it("reuses admitted journal columns while observing managed DDL and rollback", () => {
  const database = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-journal-columns-") },
  });
  const check = () =>
    runSqliteReadOperationSync(database.db, () => assertAgentDeletionJournalAvailable(database.db));
  check();
  const observation = observeHostDataSql();
  try {
    check();
    check();
    expect(
      observation.queries.filter((sql) =>
        /pragma\s+table_info\(agent_deletion_journal\)/i.test(sql),
      ),
    ).toEqual([]);
  } finally {
    observation.restore();
  }
  const foreign = openNodeSqliteDatabase(database.path);
  try {
    foreign.exec("ALTER TABLE agent_deletion_journal RENAME COLUMN agent_id TO retired_agent_id");
    expect(check).toThrow("Agent deletion journal missing");
    foreign.exec("ALTER TABLE agent_deletion_journal RENAME COLUMN retired_agent_id TO agent_id");
    expect(check).not.toThrow();
    database.db.exec(
      "BEGIN; ALTER TABLE agent_deletion_journal RENAME COLUMN agent_id TO retired_agent_id",
    );
    expect(check).toThrow("Agent deletion journal missing");
    database.db.exec("ROLLBACK");
    expect(check).not.toThrow();
  } finally {
    if (database.db.isTransaction) {
      database.db.exec("ROLLBACK");
    }
    foreign.close();
  }
});
