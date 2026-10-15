import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseCleanClose,
  readSqliteDatabaseIntegrityVerification,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { openExistingOpenClawStateWriter } from "./openclaw-state-db-existing-write.js";
import { openOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import {
  assertSupportedStateSchemaVersion,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

it("preserves full verification across a disposable startup checkpoint write", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkpoint-clean-close-") };
  const state = openOpenClawStateDatabase({ env });
  const verified = readSqliteDatabaseIntegrityVerification(requireNativeSqliteDatabase(state.db));
  expect(verified).toBeDefined();
  await closeOpenClawStateDatabaseAsync();
  const observed = observeSqliteReadSql(StatementSync.prototype);
  try {
    withOpenClawStateStartupMigrationCheckpointDatabase(
      (db) => {
        db.prepare(
          `INSERT INTO state_leases(scope, lease_key, owner, created_at, updated_at)
           VALUES('checkpoint-proof', 'global', 'startup', 1, 1)`,
        ).run();
      },
      { env, atomic: true },
    );
    expect(readSqliteDatabaseCleanClose(state.path)).toBe(true);
    const reopened = openOpenClawStateDatabase({ env });
    expect(
      readSqliteDatabaseIntegrityVerification(requireNativeSqliteDatabase(reopened.db)),
    ).toEqual(verified);
    expect(
      observed.queries.filter((sql) => /PRAGMA (?:integrity|foreign_key)_check/iu.test(sql)),
    ).toEqual([]);
  } finally {
    observed.restore();
  }
});

function validationStatements(queries: string[]): string[] {
  return queries.filter((sql) =>
    /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion|^select "value_json" from "config_machine_state")/iu.test(
      sql,
    ),
  );
}

it("admits a restarted current schema before repeated version and migration probes", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-restart-") };
  const first = openOpenClawStateDatabase({ env });
  first.db
    .prepare(
      "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run("restart.fixture", '"retained"', 1);
  closeOpenClawStateDatabaseForTest();
  // Exercise cold admission rather than restoring this orderly close's seal.
  revokeSqliteDatabaseAdmissionsForPath(first.path);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const restarted = openOpenClawStateDatabase({ env });
    expect(observation.queries.filter((sql) => /^PRAGMA user_version\b/iu.test(sql))).toHaveLength(
      1,
    );
    expect(
      observation.queries.filter((sql) =>
        /select "value_json" from "config_machine_state"/iu.test(sql),
      ),
    ).toHaveLength(1);
    expect(
      observation.queries.filter((sql) => /^PRAGMA integrity_check\b/iu.test(sql)),
    ).toHaveLength(1);
    expect(
      restarted.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("restart.fixture"),
    ).toEqual({ value_json: '"retained"' });
    restarted.db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    expect(() => assertSupportedStateSchemaVersion(restarted.db, restarted.path)).toThrow(
      /newer schema version/iu,
    );
  } finally {
    observation.restore();
  }
});

it("refuses corrupt current-version state on restart without a clean integrity receipt", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-unclean-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  // Persisted invalid bytes model an earlier process that never published clean-close proof.
  const replacement = `${pathname}.unclean`;
  copyFileSync(pathname, replacement);
  {
    using database = new DatabaseSync(replacement);
    database.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO acp_replay_events
        (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
        VALUES ('missing-session', 1, 10, 'session', NULL, '{}', 0)`);
  }
  renameSync(replacement, pathname);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(() => openOpenClawStateDatabase({ env })).toThrow(/foreign_key_check/iu);
    expect(observation.queries.some((sql) => /^PRAGMA integrity_check\b/iu.test(sql))).toBe(true);
    expect(observation.queries.some((sql) => /^PRAGMA foreign_key_check\b/iu.test(sql))).toBe(true);
  } finally {
    observation.restore();
  }
});

it("checks integrity once before index repair and once after rebuilding the index", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-repair-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const replacement = `${pathname}.replacement`;
  copyFileSync(pathname, replacement);
  {
    using database = new DatabaseSync(replacement);
    database.exec("DROP INDEX idx_task_runs_runtime_run");
  }
  renameSync(replacement, pathname);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const repaired = openOpenClawStateDatabase({ env });
    expect(
      repaired.db
        .prepare("PRAGMA index_info(idx_task_runs_runtime_run)")
        .all()
        .map((row) => row.name),
    ).toEqual(["runtime", "run_id", "source_id", "created_at", "task_id"]);
    repaired.db.exec("CREATE TABLE checkonce_later (value TEXT)");
    assertExistingOpenClawStateRuntimeSchema(requireNativeSqliteDatabase(repaired.db), pathname);
    expect(observation.queries.filter((sql) => sql === "PRAGMA integrity_check;")).toHaveLength(2);
    expect(observation.queries.filter((sql) => sql === "PRAGMA foreign_key_check;")).toHaveLength(
      2,
    );
  } finally {
    observation.restore();
  }
});

it("reuses admission after the final handles close without a seal", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-") };
  const first = openOpenClawStateDatabase({ env });
  const pathname = first.path;
  first.db.exec(`CREATE TABLE checkonce_unrelated (id INTEGER PRIMARY KEY, value TEXT);
    CREATE INDEX checkonce_unrelated_value ON checkonce_unrelated(value)`);
  // Equal catalog definitions cannot prove that metadata rows survived arbitrary DDL.
  assertExistingOpenClawStateRuntimeSchema(requireNativeSqliteDatabase(first.db), pathname);
  const survivingReader = openOpenClawStateReadOnlyLocation(pathname, pathname);
  closeOpenClawStateDatabaseForTest();
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const second = openOpenClawStateDatabase({ env });
    expect(second.db.isOpen).toBe(true);
    expect(validationStatements(observation.queries)).toEqual([]);
    survivingReader.close();
    closeOpenClawStateDatabaseForTest();
    unlinkSync(`${pathname}.seal`);
    const reopened = openOpenClawStateDatabase({ env });
    expect(validationStatements(observation.queries)).toEqual([]);
    observation.queries.length = 0;
    const reader = openOpenClawStateReadOnlyLocation(pathname, pathname);
    reader.close();
    expect(reopened.db.isOpen).toBe(true);
    expect(validationStatements(observation.queries)).toEqual([]);
  } finally {
    survivingReader.close();
    observation.restore();
  }
});

it.each(["schema_meta"] as const)(
  "does not reuse row-backed metadata after recreating %s with identical definitions",
  (table) => {
    const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-metadata-") };
    const { db, path: pathname } = openOpenClawStateDatabase({ env });
    assertExistingOpenClawStateRuntimeSchema(requireNativeSqliteDatabase(db), pathname);
    const definitions = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
      )
      .all(table);
    db.exec(`DROP TABLE ${table}; ${definitions.map(({ sql }) => sql).join(";")};`);
    expect(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).toEqual({ total: 0 });
    expect(() =>
      assertExistingOpenClawStateRuntimeSchema(requireNativeSqliteDatabase(db), pathname),
    ).toThrow(/inconsistent ownership or schema metadata/iu);
  },
);

it.each(["newer header"] as const)(
  "invalidates retained subset admission after a tracked %s change",
  () => {
    const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-subset-") };
    const state = openOpenClawStateDatabase({ env });
    const options = { env, path: state.path };
    const writer = openExistingOpenClawStateWriter(options, {
      schemaSql: extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"),
      operationLabel: "checkonce subset",
    });
    try {
      writer.run(() => undefined, options);
      state.db.exec("CREATE TABLE subset_unrelated (id INTEGER)");
      writer.run(() => undefined, options);
      const observed = observeSqliteReadSql(StatementSync.prototype);
      try {
        writer.run(() => undefined, options);
        expect(validationStatements(observed.queries)).toEqual([]);
      } finally {
        observed.restore();
      }
      state.db.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      const mutate = vi.fn();
      expect(() => writer.run(mutate, options)).toThrow(/newer schema version/iu);
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      writer.close();
    }
  },
);

it.each(["newer header"] as const)(
  "readmits startup checkpoint storage after a tracked %s change",
  () => {
    const root = directories.make("state-checkonce-checkpoint-");
    const options = {
      env: { OPENCLAW_STATE_DIR: root },
      path: path.join(root, "state.sqlite"),
      atomic: true,
    };
    {
      using seed = openNodeSqliteDatabase(options.path);
      seed.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "schema_meta"));
      seed.exec(`PRAGMA user_version=1;
        INSERT INTO schema_meta(meta_key, role, schema_version, created_at, updated_at)
        VALUES('primary', 'global', 1, 1, 1)`);
    }
    const callback = vi.fn(
      (db: DatabaseSync) => db.prepare("SELECT COUNT(*) AS total FROM state_leases").get()?.total,
    );
    const read = () => withOpenClawStateStartupMigrationCheckpointDatabase(callback, options);
    expect(read()).toBe(0);
    using peer = openNodeSqliteDatabase(options.path);
    peer.exec("CREATE TABLE checkpoint_unrelated (id INTEGER)");
    expect(read()).toBe(0);
    const observed = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(read()).toBe(0);
      expect(validationStatements(observed.queries)).toEqual([]);
    } finally {
      observed.restore();
    }
    peer.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    callback.mockClear();
    expect(read).toThrow(/newer schema version/iu);
    expect(callback).not.toHaveBeenCalled();
  },
);

it("validates a replacement file before reusing a shared-state pathname", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-replaced-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const replacement = path.join(path.dirname(pathname), "replacement.sqlite");
  copyFileSync(pathname, replacement);
  const database = new DatabaseSync(replacement);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
  database.close();
  renameSync(replacement, pathname);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    expect(() => openOpenClawStateDatabase({ env })).toThrow(/newer schema version/iu);
    expect(validationStatements(observation.queries).length).toBeGreaterThan(0);
  } finally {
    observation.restore();
  }
});

it("keeps a historical first version lookup private when the current catalog is unpublished", () => {
  const pathname = path.join(directories.make("state-checkonce-history-"), "state.sqlite");
  using writer = openNodeSqliteDatabase(pathname);
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1); PRAGMA user_version=1`);
  admitSqliteSchema(writer);
  using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
  admitSqliteSchema(reader);
  const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
  runSqliteDeferredTransactionSync(reader, () => {
    reader.prepare("SELECT * FROM sample").get();
    getAdmittedSqliteSchemaFacts(reader);
    writer.setAuthorizer(() => constants.SQLITE_OK);
    writer.exec(`PRAGMA user_version=${futureVersion}`);
    expect(readStateSchemaContentVersion(reader)).toBe(1);
  });
  writer.setAuthorizer(null);
  using current = openNodeSqliteDatabase(pathname, { readOnly: true });
  expect(() => assertSupportedStateSchemaVersion(current, pathname)).toThrow(
    `uses newer schema version ${futureVersion}`,
  );
});

it("keeps observed state versions current without caching caller floors", () => {
  const pathname = path.join(directories.make("state-checkonce-version-"), "state.sqlite");
  using database = openNodeSqliteDatabase(pathname);
  database.exec("PRAGMA user_version = 1");
  admitSqliteSchema(database);
  expect(readStateSchemaContentVersion(database, OPENCLAW_STATE_SCHEMA_VERSION + 1)).toBe(
    OPENCLAW_STATE_SCHEMA_VERSION + 1,
  );
  expect(readStateSchemaContentVersion(database)).toBe(1);
  expect(assertSupportedStateSchemaVersion(database, pathname)).toBe(1);
  {
    using reader = openNodeSqliteDatabase(pathname, { readOnly: true });
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(readStateSchemaContentVersion(reader)).toBe(1);
      expect(assertSupportedStateSchemaVersion(reader, pathname)).toBe(1);
      expect(validationStatements(observation.queries)).toEqual([]);
    } finally {
      observation.restore();
    }
  }

  database.exec("PRAGMA user_version = 2");
  expect(assertSupportedStateSchemaVersion(database, pathname)).toBe(2);
  expect(readStateSchemaContentVersion(database)).toBe(2);

  const futureVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
  database.exec(`PRAGMA user_version = ${futureVersion}`);
  expect(() => assertSupportedStateSchemaVersion(database, pathname)).toThrow(
    `uses newer schema version ${futureVersion}`,
  );
  expect(readStateSchemaContentVersion(database)).toBe(futureVersion);
});
