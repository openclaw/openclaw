import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { expectRows, readRow as row } from "./openclaw-state-db-fixtures.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs: string[] = [];
type Database = EngineConnection;
const leaseTable = "SELECT name FROM sqlite_schema WHERE name = 'state_leases'";
const metadata = "SELECT * FROM schema_meta WHERE meta_key = 'primary'";

function fixture(retired = false) {
  const stateDir = makeTempDir(tempDirs, "agent-db-retired-lease-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (retired) {
    installRetiredLeaseSchema(databasePath);
  }
  const withDb = <T>(run: (db: Database) => T, readOnly = false) => {
    using db = openNodeSqliteDatabase(databasePath, { readOnly });
    return run(db);
  };
  const before = withDb((db) => row(db, metadata), true);
  const verify = (run: (db: Database) => void) =>
    withDb((db) => {
      expect(row(db, metadata)).toEqual(before);
      expect(row(db, "PRAGMA user_version")).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      run(db);
    }, true);
  return { databasePath, env, withDb, verify };
}

function installRetiredLeaseSchema(databasePath: string): void {
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
      CREATE TABLE state_leases (
        scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
        expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, lease_key)
      ) STRICT;
      CREATE INDEX idx_agent_state_leases_expiry ON state_leases(expires_at, scope, lease_key)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX idx_agent_state_leases_owner ON state_leases(owner, updated_at DESC);
      INSERT INTO state_leases VALUES ('retired', 'orphan', 'nobody', NULL, NULL, NULL, 1, 1);
      ANALYZE state_leases;
    `);
}

function migrate(databasePath: string, env: NodeJS.ProcessEnv) {
  return withAgentDatabaseMaintenanceLease({ env }, (maintenance) =>
    migrateOpenClawAgentDatabaseForMaintenance(
      { agentId: "worker-1", pathname: databasePath },
      maintenance,
    ),
  );
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

it("repairs a mis-stamped v17 database while preserving auth and ownership", async () => {
  const { env, withDb, verify } = fixture(true);
  withDb((database) => {
    database
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("last-good", '{"profile":"primary"}', 10);
    database
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("primary", '{"profiles":{"primary":{"provider":"openai"}}}', 10);
  });

  expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);
  expect((await migrateLegacyMediaPersistence({ env })).warnings).toEqual([]);

  verify((repaired) => {
    expect(
      row(repaired, "SELECT state_json FROM auth_profile_state WHERE state_key = 'last-good'"),
    ).toEqual({ state_json: '{"profile":"primary"}' });
    expect(
      row(repaired, "SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'"),
    ).toEqual({ store_json: '{"profiles":{"primary":{"provider":"openai"}}}' });
    expectRows(
      repaired,
      `SELECT type, name FROM sqlite_schema
      WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner')`,
      [],
    );
    expectRows(repaired, "SELECT tbl, idx FROM sqlite_stat1 WHERE tbl = 'state_leases'", []);
    expect(row(repaired, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    expectRows(repaired, "PRAGMA foreign_key_check", []);
  });
});

it("leaves a clean v17 database unchanged", async () => {
  const { databasePath, env, withDb, verify } = fixture();
  const beforeSchemaVersion = withDb((db) => row(db, "PRAGMA schema_version"), true);
  await migrate(databasePath, env);
  verify((after) => {
    expect(row(after, "PRAGMA schema_version")).toEqual(beforeSchemaVersion);
    expect(row(after, leaseTable)).toBeUndefined();
  });
});

it("rejects a foreign state_leases structure without changing it", async () => {
  const { databasePath, env, withDb, verify } = fixture();
  withDb((database) => {
    database.exec(`
        CREATE TABLE state_leases (
          foreign_id TEXT NOT NULL PRIMARY KEY, foreign_payload TEXT NOT NULL
        ) STRICT;
        INSERT INTO state_leases VALUES ('foreign', 'preserve-me');
      `);
  });

  await expect(migrate(databasePath, env)).rejects.toThrow(
    /state_leases.*noncanonical|column definitions differ for state_leases/iu,
  );

  verify((after) =>
    expectRows(after, "SELECT * FROM state_leases", [
      { foreign_id: "foreign", foreign_payload: "preserve-me" },
    ]),
  );
});

it("rolls back the lease drop when canonical validation fails", async () => {
  const { databasePath, env, withDb, verify } = fixture(true);
  withDb((database) => {
    database.exec(`
        DROP TABLE session_key_contract;
        CREATE VIEW session_key_contract AS SELECT 1 AS id, 'main' AS main_key, 0 AS updated_at;
      `);
  });

  await expect(migrate(databasePath, env)).rejects.toThrow(/session_key_contract/iu);

  verify((after) => {
    expectRows(after, "SELECT scope, lease_key FROM state_leases", [
      { lease_key: "orphan", scope: "retired" },
    ]);
    expectRows(
      after,
      `SELECT name FROM sqlite_schema
             WHERE type = 'index' AND name LIKE 'idx_agent_state_leases_%'
             ORDER BY name`,
      [{ name: "idx_agent_state_leases_expiry" }, { name: "idx_agent_state_leases_owner" }],
    );
  });
});

it("repairs the same canonical drift through the writable schema owner", () => {
  const { env, withDb } = fixture(true);
  expect(
    withOpenClawAgentDatabaseReadOnly(
      ({ db }) => row(db, "SELECT COUNT(*) AS count FROM state_leases"),
      { agentId: "worker-1", env },
    ),
  ).toEqual({ found: true, value: { count: 1 } });
  withDb((db) => expect(row(db, leaseTable)).toEqual({ name: "state_leases" }), true);

  const repaired = openOpenClawAgentDatabase({ agentId: "worker-1", env });

  expect(row(repaired.db, leaseTable)).toBeUndefined();
});
