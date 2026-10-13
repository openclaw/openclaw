import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { publishStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { markCurrentStateSchemaVersion } from "./openclaw-state-db-maintenance.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "./openclaw-state-db-schema-version.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const database of databases.splice(0).toReversed()) {
      database.close();
    }
    cleanup();
  }),
);
const schema = `
  CREATE TABLE config_machine_state (
    state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  PRAGMA user_version = 7;
`;

function openDatabase(
  options: {
    pathname?: string;
    marker?: number;
    tracking?: "untracked" | "unadmitted";
  } = {},
) {
  const pathname = options.pathname ?? ":memory:";
  const database =
    options.tracking === "untracked"
      ? new DatabaseSync(pathname)
      : openNodeSqliteDatabase(pathname);
  databases.push(database);
  database.exec(schema);
  if (options.marker !== undefined) {
    database
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
      .run(CONTENT_VERSION_KEY, String(options.marker));
  }
  enableNodeSqliteKyselyStatementCache(database);
  if (!options.tracking) {
    admitSqliteSchema(database);
  }
  return database;
}

const read = (database: DatabaseSync, published?: number) =>
  runSqliteReadOperationSync(database, () => readStateSchemaContentVersion(database, published));

describe("shared-state content version facts", () => {
  it("reads untracked mutation, rollback, malformed content, and schema replacement directly", () => {
    const database = openDatabase({ tracking: "untracked" });
    const write = database.prepare("INSERT OR REPLACE INTO config_machine_state VALUES (?, ?, 1)");
    expect(read(database)).toBe(7);
    write.run(CONTENT_VERSION_KEY, "11");
    expect(read(database)).toBe(11);
    database.exec("BEGIN; SAVEPOINT marker");
    write.run(CONTENT_VERSION_KEY, "12");
    expect(read(database)).toBe(12);
    database.exec("ROLLBACK TO marker");
    expect(read(database)).toBe(11);
    database.exec("RELEASE marker; COMMIT");
    expect(read(database)).toBe(11);
    write.run(CONTENT_VERSION_KEY, "malformed");
    expect(() => read(database)).toThrow("Invalid shared state schema content version");
    write.run(CONTENT_VERSION_KEY, "11");
    database.exec("PRAGMA user_version = 14");
    expect(read(database)).toBe(14);
    database.exec("DROP TABLE config_machine_state");
    expect(read(database)).toBe(14);
    database.exec(schema);
    database
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
      .run(CONTENT_VERSION_KEY, "19");
    expect(read(database)).toBe(19);
  });

  it("observes raw foreign increases after an untracked pinned snapshot ends", () => {
    const pathname = path.join(tempDirs.make("openclaw-content-version-"), "state.sqlite");
    const database = openDatabase({ pathname, marker: 11, tracking: "untracked" });
    database.exec("PRAGMA journal_mode=WAL");
    const peer = new DatabaseSync(pathname);
    databases.push(peer);
    const update = peer.prepare(
      "UPDATE config_machine_state SET value_json = ? WHERE state_key = ?",
    );
    expect(read(database)).toBe(11);
    update.run("12", CONTENT_VERSION_KEY);
    expect(read(database)).toBe(12);
    runSqliteSchemaReadSnapshotSync(database, () => {
      expect(read(database)).toBe(12);
      update.run("13", CONTENT_VERSION_KEY);
      expect(read(database)).toBe(12);
    });
    expect(read(database)).toBe(13);
  });
});

it("publishes migration-owned content markers through rollback and authorizer checks", () => {
  using database = openNodeSqliteDatabase(":memory:");
  for (const table of ["config_machine_state", "audit_events", "update_runs"]) {
    database.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
  }
  database.prepare("INSERT INTO config_machine_state VALUES (?, '1', 1)").run(CONTENT_VERSION_KEY);
  database
    .prepare(`INSERT INTO update_runs (
    run_id, created_at_ms, updated_at_ms, trigger, phase, status,
    origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json
  ) VALUES ('deferred-marker', ?, ?, 'cli', 'verifying', 'running', '{}', '{}',
    '{"version":"2026.9.2"}', '{}', '[]', '{}', '[]')`)
    .run(Date.now(), Date.now());
  database.exec("PRAGMA user_version=1");
  admitSqliteSchema(database);
  const readVersion = (published?: number) =>
    runSqliteReadOperationSync(database, () => readStateSchemaContentVersion(database, published));
  expect(readVersion()).toBe(1);
  const refusal = new Error("synthetic migration rollback");
  runSqliteImmediateTransactionSync(database, () => {
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        database
          .prepare("UPDATE config_machine_state SET value_json='2' WHERE state_key=?")
          .run(CONTENT_VERSION_KEY);
        publishStateSchemaVersionAdmission(database, { userVersion: 1, contentVersion: 2 });
        expect(readVersion()).toBe(2);
        throw refusal;
      }),
    ).toThrow(refusal);
    expect(
      database
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
        .get(CONTENT_VERSION_KEY),
    ).toEqual({ value_json: "1" });
    expect(readVersion()).toBe(1);
    database.exec("SAVEPOINT raw_marker");
    database
      .prepare("UPDATE config_machine_state SET value_json='2' WHERE state_key=?")
      .run(CONTENT_VERSION_KEY);
    publishStateSchemaVersionAdmission(database, { userVersion: 1, contentVersion: 2 });
    expect(readVersion()).toBe(2);
    database.exec("ROLLBACK TO raw_marker; RELEASE raw_marker");
    expect(
      database
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
        .get(CONTENT_VERSION_KEY),
    ).toEqual({ value_json: "1" });
    expect(readVersion()).toBe(1);
  });
  expect(readVersion()).toBe(1);
  expect(() =>
    runSqliteImmediateTransactionSync(database, () => {
      markCurrentStateSchemaVersion(database);
      expect(readVersion()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
      throw refusal;
    }),
  ).toThrow(refusal);
  expect(readVersion()).toBe(1);
  runSqliteImmediateTransactionSync(database, () => markCurrentStateSchemaVersion(database));
  expect(readVersion()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  expect(readVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1)).toBe(OPENCLAW_STATE_SCHEMA_VERSION + 1);
  expect(readVersion()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  database.setAuthorizer((action, table) =>
    action === constants.SQLITE_READ && table === "config_machine_state"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  expect(readVersion).toThrowError(
    expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 23 }),
  );
  database.setAuthorizer(null);
  expect(readVersion()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
});
