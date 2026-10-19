import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
} from "./openclaw-state-db-additive-columns.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  ensureAdditiveStateColumns,
  ensureDevicePairSetupBootstrapSchema,
} from "./openclaw-state-db-schema-additive.js";
import { assertOpenClawStateDatabaseForMaintenance } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

describe("OpenClaw database maintenance schema validation", () => {
  it("accepts compatible future columns in shared-state and agent databases", () => {
    using globalDatabase = createDatabase("global");
    using agentDatabase = createDatabase("agent");
    globalDatabase.exec("ALTER TABLE worktrees ADD COLUMN future_note TEXT;");
    agentDatabase.exec("ALTER TABLE conversations ADD COLUMN future_note TEXT;");

    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(globalDatabase, {
        pathname: "global.sqlite",
      }),
    ).not.toThrow();
    expect(() =>
      assertOpenClawAgentDatabaseForMaintenance(agentDatabase, {
        agentId: "worker-1",
        pathname: "agent.sqlite",
      }),
    ).not.toThrow();
  });

  it("keeps every same-version additive column bare and canonical", () => {
    const additiveColumns = CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(
      ({ columnName, tableName }) => `${tableName}.${columnName}`,
    );
    expect(OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingColumns).toEqual(
      additiveColumns,
    );
    expect(new Set(additiveColumns).size).toBe(additiveColumns.length);

    using database = createDatabase("global");
    const authorizationIndex = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_user_profile_identities_authorization'",
      )
      .get()?.sql;
    if (typeof authorizationIndex !== "string") {
      throw new Error("Canonical channel authorization index is missing");
    }
    // A schema predating the authorization columns also predates their index.
    database.exec("DROP INDEX idx_user_profile_identities_authorization;");
    for (const { columnName, dataType, tableName } of CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
      expect(["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"]).toContain(dataType);
      expectBareColumn(database, tableName, columnName, dataType);
      database.exec(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}";`);
    }

    ensureAdditiveStateColumns(database, "runtime");
    database.exec(authorizationIndex);
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(database, {
        pathname: "global.sqlite",
      }),
    ).not.toThrow();
    for (const {
      columnName,
      dataType,
      tableName,
    } of CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
      expectBareColumn(database, tableName, columnName, dataType);
    }
    expect(readColumnContract(database, "device_bootstrap_tokens", "setup_id")).toBeUndefined();

    ensureDevicePairSetupBootstrapSchema(database);
    expectBareColumn(database, "device_bootstrap_tokens", "setup_id", "TEXT");
  });

  it("admits the retired chunk path index read-only and never repairs it back", () => {
    using database = createDatabase("agent");
    const retiredIndex = () =>
      database
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_memory_index_chunks_path'")
        .get();
    expect(retiredIndex()).toBeUndefined();
    database.exec("CREATE INDEX idx_memory_index_chunks_path ON memory_index_chunks(path)");
    for (const retained of [true, false]) {
      if (!retained) {
        ensureMemoryIndexSchema({ db: database, cacheEnabled: true, ftsEnabled: false });
        database.exec("DROP INDEX idx_memory_index_chunks_path_source");
        expect(
          repairCanonicalSqliteIndexes(database, "agent.sqlite", OPENCLAW_AGENT_SCHEMA_SQL),
        ).toEqual(["idx_memory_index_chunks_path_source"]);
        expect(retiredIndex()).toBeUndefined();
      }
      database.exec("PRAGMA query_only = ON");
      expect(() =>
        assertOpenClawAgentDatabaseForMaintenance(database, {
          agentId: "worker-1",
          pathname: "agent.sqlite",
        }),
      ).not.toThrow();
      database.exec("PRAGMA query_only = OFF");
    }
  });
});

function createDatabase(role: "global" | "agent") {
  const global = role === "global";
  const schema = global ? OPENCLAW_STATE_SCHEMA_SQL : OPENCLAW_AGENT_SCHEMA_SQL;
  const version = global ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  database.exec(`PRAGMA user_version = ${version};`);
  database
    .prepare(`INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', ?, ?, ?, NULL, 1, 1)`)
    .run(role, version, global ? null : "worker-1");
  return database;
}

function expectBareColumn(database: DatabaseSync, table: string, name: string, type: string) {
  expect(readColumnContract(database, table, name)).toEqual({
    dflt_value: null,
    hidden: 0,
    name,
    notnull: 0,
    pk: 0,
    type,
  });
}

function readColumnContract(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
): Record<string, unknown> | undefined {
  const column = (
    database.prepare(`PRAGMA table_xinfo("${tableName}")`).all() as Array<Record<string, unknown>>
  ).find((candidate) => candidate.name === columnName);
  if (!column) {
    return undefined;
  }
  const { dflt_value, hidden, name, notnull, pk, type } = column;
  return { dflt_value, hidden, name, notnull, pk, type };
}
