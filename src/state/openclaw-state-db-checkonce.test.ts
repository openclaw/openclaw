import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  readSqliteDatabaseCleanClose,
  readSqliteDatabaseIntegrityVerification,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase as nativeDatabase } from "../test-utils/native-sqlite.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS as BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema as assertRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openExistingOpenClawStateWriter as openExistingWriter } from "./openclaw-state-db-existing-write.js";
import { expectRow, readRow, readRows } from "./openclaw-state-db-fixtures.test-support.js";
import {
  assertSupportedStateSchemaVersion as assertVersion,
  readStateSchemaContentVersion as readVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  closeOpenClawStateDatabaseAsync as closeStateAsync,
  openOpenClawStateDatabase as openState,
  withOpenClawStateStartupMigrationCheckpointDatabase as withCheckpoint,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL as SCHEMA_SQL } from "./openclaw-state-schema.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeState();
    vi.restoreAllMocks();
    cleanup();
  }),
);

function replacedState(sql: string) {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-replacement-") };
  const pathname = openState({ env }).path;
  closeState();
  const replacement = `${pathname}.replacement`;
  copyFileSync(pathname, replacement);
  {
    using database = new DatabaseSync(replacement);
    database.exec(sql);
  }
  renameSync(replacement, pathname);
  return { env, pathname };
}

it("preserves full verification across a disposable startup checkpoint write", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkpoint-clean-close-") };
  const state = openState({ env });
  const verified = readSqliteDatabaseIntegrityVerification(nativeDatabase(state.db));
  expect(verified).toBeDefined();
  await closeStateAsync();
  const observed = observeSqliteReadSql(StatementSync.prototype);
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  withCheckpoint(
    (db) => {
      expect(readRow(db, "PRAGMA busy_timeout")).toEqual({ timeout: BUSY_TIMEOUT_MS });
      db.prepare(
        `INSERT INTO state_leases(scope, lease_key, owner, created_at, updated_at)
         VALUES('checkpoint-proof', 'global', 'startup', 1, 1)`,
      ).run();
    },
    { env, atomic: true },
  );
  expect(exec.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
  expect(readSqliteDatabaseCleanClose(state.path)).toBe(true);
  const reopened = openState({ env });
  expect(readSqliteDatabaseIntegrityVerification(nativeDatabase(reopened.db))).toEqual(verified);
  expect(
    observed.queries.filter((sql) => /PRAGMA (?:integrity|foreign_key)_check/iu.test(sql)),
  ).toEqual([]);
});

const validationSql =
  /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion|^select "value_json" from "config_machine_state")/iu;
const validationStatements = (queries: string[]) =>
  queries.filter((sql) => validationSql.test(sql));

function expectTrackedReadmission(
  db: EngineConnection,
  read: () => unknown,
  callback: { mockClear(): unknown },
  expected?: number,
) {
  db.exec("CREATE TABLE admission_unrelated (id INTEGER)");
  expect(read()).toBe(expected);
  const observed = observeSqliteReadSql(StatementSync.prototype);
  expect(read()).toBe(expected);
  expect(validationStatements(observed.queries)).toEqual([]);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  callback.mockClear();
  expect(read).toThrow(/newer schema version/iu);
  expect(callback).not.toHaveBeenCalled();
}

it("admits a restarted current schema before repeated version and migration probes", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-restart-") };
  const first = openState({ env });
  first.db.exec(`INSERT INTO config_machine_state VALUES ('restart.fixture', '"retained"', 1)`);
  closeState();
  // Exercise cold admission rather than restoring this orderly close's seal.
  revokeSqliteDatabaseAdmissionsForPath(first.path);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  const restarted = openState({ env });
  for (const pattern of [
    /^PRAGMA user_version\b/iu,
    /select "value_json" from "config_machine_state"/iu,
    /^PRAGMA integrity_check\b/iu,
  ]) {
    expect(observation.queries.filter((sql) => pattern.test(sql))).toHaveLength(1);
  }
  expectRow(
    restarted.db,
    "SELECT value_json FROM config_machine_state WHERE state_key = ?",
    { value_json: '"retained"' },
    "restart.fixture",
  );
  restarted.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  expect(() => assertVersion(restarted.db, restarted.path)).toThrow(/newer schema version/iu);
});

it("refuses corrupt current-version state on restart without a clean integrity receipt", () => {
  // Persisted invalid bytes model an earlier process that never published clean-close proof.
  const { env } = replacedState(`PRAGMA foreign_keys = OFF;
      INSERT INTO acp_replay_events
        (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
        VALUES ('missing-session', 1, 10, 'session', NULL, '{}', 0)`);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  expect(() => openState({ env })).toThrow(/foreign_key_check/iu);
  expect(observation.queries.some((sql) => /^PRAGMA integrity_check\b/iu.test(sql))).toBe(true);
  expect(observation.queries.some((sql) => /^PRAGMA foreign_key_check\b/iu.test(sql))).toBe(true);
});

it("checks fresh-state integrity without repeating its admitted catalog presence probe", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-fresh-") };
  const observation = observeSqliteReadSql(StatementSync.prototype);
  const opened = openState({ env });
  expect(readVersion(opened.db)).toBe(SCHEMA_VERSION);
  expect(observation.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql))).toHaveLength(
    1,
  );
  expect(
    observation.queries.filter((sql) =>
      /^SELECT 1 FROM sqlite_(?:master|schema)\b.*LIMIT 1$/iu.test(sql),
    ),
  ).toEqual([]);
});

it("repairs canonical indexes and shares admission until the final handle closes", () => {
  const { env, pathname } = replacedState("DROP INDEX idx_task_runs_runtime_run");
  const observation = observeSqliteReadSql(StatementSync.prototype);
  const repaired = openState({ env });
  expect(
    readRows(repaired.db, "PRAGMA index_info(idx_task_runs_runtime_run)").map((row) => row.name),
  ).toEqual(["runtime", "run_id", "source_id", "created_at", "task_id"]);
  repaired.db.exec("CREATE TABLE checkonce_later (value TEXT)");
  assertRuntimeSchema(nativeDatabase(repaired.db), pathname);
  closeState();
  unlinkSync(`${pathname}.seal`);
  observation.queries.length = 0;
  expect(openState({ env }).db.isOpen).toBe(true);
  expect(validationStatements(observation.queries)).toEqual([]);
});

it("does not reuse row-backed metadata after recreating schema_meta with identical definitions", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-metadata-") };
  const { db, path: pathname } = openState({ env });
  assertRuntimeSchema(nativeDatabase(db), pathname);
  const definitionSql =
    "SELECT sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END";
  const definitions = readRows(db, definitionSql, "schema_meta");
  db.exec(`DROP TABLE schema_meta; ${definitions.map(({ sql }) => sql).join(";")};`);
  expectRow(db, "SELECT COUNT(*) AS total FROM schema_meta", { total: 0 });
  expect(() => assertRuntimeSchema(nativeDatabase(db), pathname)).toThrow(
    /inconsistent ownership or schema metadata/iu,
  );
});

it("invalidates retained subset admission after a tracked header change", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-subset-") };
  const state = openState({ env });
  const options = { env, path: state.path };
  const writer = openExistingWriter(options, {
    schemaSql: extractSqliteTableSchema(SCHEMA_SQL, "config_machine_state"),
    operationLabel: "checkonce subset",
  });
  try {
    const mutate = vi.fn();
    writer.run(mutate, options);
    expectTrackedReadmission(state.db, () => writer.run(mutate, options), mutate);
  } finally {
    writer.close();
  }
});

it("readmits startup checkpoint storage after a tracked header change", () => {
  const root = directories.make("state-checkonce-checkpoint-");
  const options = {
    env: { OPENCLAW_STATE_DIR: root },
    path: path.join(root, "state.sqlite"),
    atomic: true,
  };
  {
    using seed = openNodeSqliteDatabase(options.path);
    seed.exec(extractSqliteTableSchema(SCHEMA_SQL, "schema_meta"));
    seed.exec(`PRAGMA user_version=1;
        INSERT INTO schema_meta(meta_key, role, schema_version, created_at, updated_at)
        VALUES('primary', 'global', 1, 1, 1)`);
  }
  const callback = vi.fn(
    (db: EngineConnection) => readRow(db, "SELECT COUNT(*) AS total FROM state_leases")?.total,
  );
  const read = () => withCheckpoint(callback, options);
  expect(read()).toBe(0);
  revokeSqliteDatabaseAdmissionsForPath(options.path);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(read()).toBe(0);
    // Keep the pre-transaction probe, admission read, and final catalog capture.
    expect(observation.queries.filter((sql) => /^PRAGMA user_version\b/iu.test(sql))).toHaveLength(
      3,
    );
  } finally {
    observation.restore();
  }
  using peer = openNodeSqliteDatabase(options.path);
  expectTrackedReadmission(peer, read, callback, 0);
});

it("validates a replacement file before reusing a shared-state pathname", () => {
  const { env } = replacedState(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  expect(() => openState({ env })).toThrow(/newer schema version/iu);
  expect(validationStatements(observation.queries).length).toBeGreaterThan(0);
});

it("keeps a historical first version lookup private when the current catalog is unpublished", () => {
  const pathname = path.join(directories.make("state-checkonce-history-"), "state.sqlite");
  using writer = openNodeSqliteDatabase(pathname);
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1); PRAGMA user_version=1`);
  admitSqliteSchema(writer);
  using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  admitSqliteSchema(reader);
  const futureVersion = SCHEMA_VERSION + 1;
  runSqliteDeferredTransactionSync(reader, () => {
    readRow(reader, "SELECT * FROM sample");
    getAdmittedSqliteSchemaFacts(reader);
    writer.setAuthorizer(() => constants.SQLITE_OK);
    writer.exec(`PRAGMA user_version=${futureVersion}`);
    expect(readVersion(reader)).toBe(1);
  });
  writer.setAuthorizer(null);
  using current = openNodeSqliteDatabase(pathname, { readOnly: true });
  expect(() => assertVersion(current, pathname)).toThrow(
    `uses newer schema version ${futureVersion}`,
  );
});

it("keeps observed state versions current without caching caller floors", () => {
  const pathname = path.join(directories.make("state-checkonce-version-"), "state.sqlite");
  using database = openNodeSqliteDatabase(pathname);
  database.exec("PRAGMA user_version = 1");
  admitSqliteSchema(database);
  expect(readVersion(database, SCHEMA_VERSION + 1)).toBe(SCHEMA_VERSION + 1);
  expect(readVersion(database)).toBe(1);
  expect(assertVersion(database, pathname)).toBe(1);
  {
    using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
    const observation = observeSqliteReadSql(StatementSync.prototype);
    expect(readVersion(reader)).toBe(1);
    expect(assertVersion(reader, pathname)).toBe(1);
    expect(validationStatements(observation.queries)).toEqual([]);
  }

  database.exec("PRAGMA user_version = 2");
  expect(assertVersion(database, pathname)).toBe(2);
  expect(readVersion(database)).toBe(2);

  const futureVersion = SCHEMA_VERSION + 1;
  database.exec(`PRAGMA user_version = ${futureVersion}`);
  expect(() => assertVersion(database, pathname)).toThrow(
    `uses newer schema version ${futureVersion}`,
  );
  expect(readVersion(database)).toBe(futureVersion);
});
