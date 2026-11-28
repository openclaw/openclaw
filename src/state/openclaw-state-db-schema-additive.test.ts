import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { stageSqliteCommittedPublication } from "../infra/sqlite-post-commit.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "../infra/sqlite-schema-facts.test-support.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { ensureMeetingTranscriptsSchema } from "../transcripts/sqlite-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, readRow, readRows } from "./openclaw-state-db-fixtures.test-support.js";
import {
  assertAgentDeletionJournalAvailable,
  ensureAgentDatabaseLeaseSchema,
  ensureSecretStoreSchema,
} from "./openclaw-state-db-schema-additive.js";
import {
  openExistingOpenClawStateDatabaseReadOnly as openReadOnly,
  openOpenClawStateDatabase as openState,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema-ensure.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

const { openDatabase } = useSqliteSchemaTestFixture();

const featureEnsurer = () =>
  createOpenClawStateSchemaEnsurer({
    table: "web_push_approval_deliveries",
    indexes: ["idx_web_push_approval_deliveries_subscription"],
    endMarker: "  ON web_push_approval_deliveries(subscription_id, approval_id);\n",
    operationLabel: "test.feature-schema",
  });

function expectRepeatedSqlAbsent(pattern: (sql: string) => boolean, run: () => void) {
  const observation = observeHostDataSql();
  try {
    run();
    run();
    expect(observation.queries.filter(pattern)).toEqual([]);
  } finally {
    observation.restore();
  }
}

it("retries rolled-back feature DDL and publishes only its durable installation", () => {
  const database = openState({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-feature-rollback-") },
  });
  const ensure = featureEnsurer();
  using reader = openNodeSqliteDatabase(database.path);
  const installed = () =>
    readRow(
      reader,
      "SELECT name FROM sqlite_schema WHERE name = ?",
      "web_push_approval_deliveries",
    ) !== undefined;
  const publications: boolean[] = [];
  const install = () => {
    ensure({ database });
    stageSqliteCommittedPublication(database.db, {
      installFacts: () => {},
      invalidate: () => {},
      notify: () => publications.push(installed()),
    });
    expect(publications).toEqual([]);
    expect(installed()).toBe(false);
  };
  database.db.exec("BEGIN IMMEDIATE");
  try {
    expect(() => ensure({ database })).toThrow("Cannot join an unmanaged shared-state transaction");
  } finally {
    database.db.exec("ROLLBACK");
  }
  expect(() =>
    runOpenClawStateWriteTransaction(
      () => {
        install();
        throw new Error("installation refused");
      },
      { database },
    ),
  ).toThrow("installation refused");
  expect(installed()).toBe(false);
  expect(publications).toEqual([]);
  runOpenClawStateWriteTransaction(install, { database });
  expect(publications).toEqual([true]);
  expectRepeatedSqlAbsent(
    (sql) => /^(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql),
    () => featureEnsurer()({ database }),
  );
});

it("installs additive DDL on the write runner's connection and rolls it back there", () => {
  const outer = openDatabase();
  const writer = openDatabase();
  const ensure = createSqliteSchemaEnsurer(() => "CREATE TABLE feature (id INTEGER)", {
    tables: ["feature"],
  });
  const installed = (db: EngineConnection) =>
    readRow(db, "SELECT name FROM sqlite_schema WHERE name = 'feature'") !== undefined;

  expect(() =>
    ensure(outer, (install) =>
      runSqliteImmediateTransactionSync(writer, () => {
        install(writer);
        throw new Error("installation refused");
      }),
    ),
  ).toThrow("installation refused");
  expect(installed(outer)).toBe(false);
  expect(installed(writer)).toBe(false);

  ensure(outer, (install) => runSqliteImmediateTransactionSync(writer, () => install(writer)));
  expect(installed(outer)).toBe(false);
  expect(installed(writer)).toBe(true);
});

it("lazily adds allowed_hosts to a v6 secret store without changing user_version", () => {
  using database = new DatabaseSync(":memory:");

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

  expectRow(database, "PRAGMA user_version", { user_version: 6 });
  expectRow(
    database,
    'SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?) WHERE name = ?',
    { name: "allowed_hosts", type: "TEXT", notnull: 0, dflt_value: null },
    "secret_store_entries",
    "allowed_hosts",
  );
});

it("adds lease provenance without certifying legacy owners or changing their identifiers", () => {
  using database = new DatabaseSync(":memory:");

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
  const before = readRow(database, "SELECT * FROM agent_database_leases");

  database.exec("BEGIN");
  ensureAgentDatabaseLeaseSchema(database);
  database.exec("ROLLBACK");
  expectRow(database, "SELECT * FROM agent_database_leases", before);

  ensureAgentDatabaseLeaseSchema(database);
  expectRow(database, "SELECT * FROM agent_database_leases", { ...before, provenance: null });
  expectRow(database, "PRAGMA user_version", { user_version: 6 });
});

it("adds the caption retry index to populated same-version state without changing its rows", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-caption-index-") } };
  const database = openState(options);
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
    sessions: readRows(db, "SELECT * FROM meeting_transcript_sessions ORDER BY session_id"),
    utterances: readRows(db, "SELECT * FROM meeting_transcript_utterances ORDER BY sequence"),
    metadata: readRows(db, "SELECT * FROM schema_meta ORDER BY meta_key"),
    version: readRow(db, "PRAGMA user_version"),
  });
  const before = readState(database.db);
  expect(before.version).toEqual({ user_version: SCHEMA_VERSION });
  const indexName = "idx_meeting_transcript_utterances_id";
  const readIndex = (db: EngineConnection) =>
    readRow(
      db,
      'SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?',
      "meeting_transcript_utterances",
      indexName,
    );
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
  {
    using previous = new DatabaseSync(database.path);

    previous.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
  const reader = await openReadOnly(options);
  assert(reader);
  try {
    expect(readState(reader.db)).toEqual(before);
    expect(readIndex(reader.db)).toBeUndefined();
  } finally {
    reader.walMaintenance.close();
  }

  const repaired = openState(options);
  expect(readState(repaired.db)).toEqual(before);
  expect(readIndex(repaired.db)).toEqual({ unique: 0, partial: 1 });
  expect(
    readRows(repaired.db, "SELECT name FROM pragma_index_info(?) ORDER BY seqno", indexName).map(
      (row) => row.name,
    ),
  ).toEqual(["session_id", "session_started_at", "utterance_id"]);
  const schemaCookie = readRow(repaired.db, "PRAGMA schema_version");
  await closeStateDatabaseForTest();
  const reopened = openState(options);
  expect(readState(reopened.db)).toEqual(before);
  expectRow(reopened.db, "PRAGMA schema_version", schemaCookie);

  // A retained handle's first feature use must include the index in its canonical DDL block.
  reopened.db.exec(`DROP INDEX ${indexName}`);
  ensureMeetingTranscriptsSchema({ ...options, database: reopened });
  expect(readIndex(reopened.db)).toEqual({ unique: 0, partial: 1 });
  expect(readState(reopened.db)).toEqual(before);
});

it("reuses admitted journal columns while observing managed DDL and rollback", () => {
  const database = openState({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-journal-columns-") },
  });
  const check = () =>
    runSqliteReadOperationSync(database.db, () => assertAgentDeletionJournalAvailable(database.db));
  check();
  expectRepeatedSqlAbsent(
    (sql) => /pragma\s+table_info\(agent_deletion_journal\)/i.test(sql),
    check,
  );
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
