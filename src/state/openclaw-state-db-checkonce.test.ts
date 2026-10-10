import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
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

function validationStatements(queries: string[]): string[] {
  return queries.filter((sql) =>
    /(?:sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\bFROM\s+"?schema_meta\b|state\.schema\.contentVersion|^select "value_json" from "config_machine_state")/iu.test(
      sql,
    ),
  );
}

it("checks integrity once before index repair and once after rebuilding the index", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-repair-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const replacement = `${pathname}.replacement`;
  copyFileSync(pathname, replacement);
  {
    using database = new DatabaseSync(replacement);
    database.exec("DROP INDEX idx_task_runs_status");
  }
  renameSync(replacement, pathname);
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const repaired = openOpenClawStateDatabase({ env });
    expect(
      repaired.db
        .prepare("PRAGMA index_info(idx_task_runs_status)")
        .all()
        .map((row) => row.name),
    ).toEqual(["status"]);
    repaired.db.exec("CREATE TABLE checkonce_later (value TEXT)");
    assertExistingOpenClawStateRuntimeSchema(repaired.db, pathname);
    expect(observation.queries.filter((sql) => sql === "PRAGMA integrity_check;")).toHaveLength(2);
    expect(observation.queries.filter((sql) => sql === "PRAGMA foreign_key_check;")).toHaveLength(
      2,
    );
    closeOpenClawStateDatabaseForTest();
    observation.queries.length = 0;
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
    expect(validationStatements(observation.queries)).toEqual([]);
  } finally {
    observation.restore();
  }
});

it("reuses shared-state admission after DDL revalidation, readers, and writer retirement", () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-") };
  const first = openOpenClawStateDatabase({ env });
  const pathname = first.path;
  first.db.exec(`CREATE TABLE checkonce_unrelated (id INTEGER PRIMARY KEY, value TEXT);
    CREATE INDEX checkonce_unrelated_value ON checkonce_unrelated(value)`);
  // Equal catalog definitions cannot prove that metadata rows survived arbitrary DDL.
  assertExistingOpenClawStateRuntimeSchema(first.db, pathname);
  closeOpenClawStateDatabaseForTest();
  const observation = observeSqliteReadSql(StatementSync.prototype);
  try {
    const second = openOpenClawStateDatabase({ env });
    expect(second.db.isOpen).toBe(true);
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env });
    const reader = openOpenClawStateReadOnlyLocation(pathname, pathname);
    reader.close();
    expect(reopened.db.isOpen).toBe(true);
    expect(validationStatements(observation.queries)).toEqual([]);
  } finally {
    observation.restore();
  }
});

it.each(["config_machine_state", "schema_meta"] as const)(
  "does not reuse row-backed metadata after recreating %s with identical definitions",
  (table) => {
    const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-metadata-") };
    const { db, path: pathname } = openOpenClawStateDatabase({ env });
    assertExistingOpenClawStateRuntimeSchema(db, pathname);
    const definitions = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name=? AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
      )
      .all(table);
    db.exec(`DROP TABLE ${table}; ${definitions.map(({ sql }) => sql).join(";")};`);
    expect(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).toEqual({ total: 0 });
    if (table === "schema_meta") {
      expect(() => assertExistingOpenClawStateRuntimeSchema(db, pathname)).toThrow(
        /inconsistent ownership or schema metadata/iu,
      );
    } else {
      assertExistingOpenClawStateRuntimeSchema(db, pathname);
      expect(readStateSchemaContentVersion(db, 0)).toBe(0);
    }
  },
);

it.each([
  {
    change: "required table removal",
    sql: "DROP TABLE config_machine_state",
    object: "config_machine_state",
  },
  {
    change: "same-name index drift",
    sql: "DROP INDEX idx_state_leases_expiry; CREATE INDEX idx_state_leases_expiry ON state_leases(scope)",
    object: "idx_state_leases_expiry",
  },
  {
    change: "new canonical-table trigger",
    sql: "CREATE TRIGGER checkonce_unexpected AFTER INSERT ON config_machine_state BEGIN SELECT 1; END",
    object: "checkonce_unexpected",
  },
])("refuses stale runtime admission after $change", ({ sql, object }) => {
  const env = { OPENCLAW_STATE_DIR: directories.make("state-checkonce-shape-") };
  const { db, path: pathname } = openOpenClawStateDatabase({ env });
  expect(() => assertExistingOpenClawStateRuntimeSchema(db, pathname)).not.toThrow();
  db.exec(sql);
  expect(() => assertExistingOpenClawStateRuntimeSchema(db, pathname)).toThrow(object);
});

it.each(["required definition", "newer header"] as const)(
  "invalidates retained subset admission after a tracked %s change",
  (change) => {
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
      state.db.exec(
        change === "required definition"
          ? "ALTER TABLE config_machine_state ADD COLUMN unexpected TEXT"
          : `PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
      );
      const mutate = vi.fn();
      expect(() => writer.run(mutate, options)).toThrow(
        change === "required definition" ? /column definitions differ/iu : /newer schema version/iu,
      );
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      writer.close();
    }
  },
);

it.each(["missing table", "newer header"] as const)(
  "readmits startup checkpoint storage after a tracked %s change",
  (change) => {
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
    peer.exec(
      change === "missing table"
        ? "DROP TABLE state_leases"
        : `PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );
    callback.mockClear();
    if (change === "missing table") {
      expect(read()).toBe(0);
      expect(callback).toHaveBeenCalledOnce();
    } else {
      expect(read).toThrow(/newer schema version/iu);
      expect(callback).not.toHaveBeenCalled();
    }
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
