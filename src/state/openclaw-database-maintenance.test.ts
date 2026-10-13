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
    const globalDatabase = createGlobalDatabase();
    const agentDatabase = createAgentDatabase();
    try {
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
    } finally {
      agentDatabase.close();
      globalDatabase.close();
    }
  });

  it("keeps every same-version additive column bare and canonical", () => {
    const additiveColumns = CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(
      ({ columnName, tableName }) => `${tableName}.${columnName}`,
    );
    expect(OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingColumns).toEqual(
      additiveColumns,
    );
    expect(new Set(additiveColumns).size).toBe(additiveColumns.length);

    const database = createGlobalDatabase();
    try {
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
      for (const {
        columnName,
        dataType,
        tableName,
      } of CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
        expect(["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"]).toContain(dataType);
        expect(readColumnContract(database, tableName, columnName)).toEqual({
          dflt_value: null,
          hidden: 0,
          name: columnName,
          notnull: 0,
          pk: 0,
          type: dataType,
        });
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
        expect(readColumnContract(database, tableName, columnName)).toEqual({
          dflt_value: null,
          hidden: 0,
          name: columnName,
          notnull: 0,
          pk: 0,
          type: dataType,
        });
      }
      expect(readColumnContract(database, "device_bootstrap_tokens", "setup_id")).toBeUndefined();

      ensureDevicePairSetupBootstrapSchema(database);
      expect(readColumnContract(database, "device_bootstrap_tokens", "setup_id")).toEqual({
        dflt_value: null,
        hidden: 0,
        name: "setup_id",
        notnull: 0,
        pk: 0,
        type: "TEXT",
      });
    } finally {
      database.close();
    }
  });

  it("admits the retired chunk path index read-only and never repairs it back", () => {
    using database = createAgentDatabase();
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

function createGlobalDatabase(schemaSql = OPENCLAW_STATE_SCHEMA_SQL): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(schemaSql);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  database
    .prepare(
      `
        INSERT INTO schema_meta (
          meta_key,
          role,
          schema_version,
          agent_id,
          app_version,
          created_at,
          updated_at
        ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)
      `,
    )
    .run(OPENCLAW_STATE_SCHEMA_VERSION);
  return database;
}

function createAgentDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  database
    .prepare(
      `
        INSERT INTO schema_meta (
          meta_key,
          role,
          schema_version,
          agent_id,
          app_version,
          created_at,
          updated_at
        ) VALUES ('primary', 'agent', ?, 'worker-1', NULL, 1, 1)
      `,
    )
    .run(OPENCLAW_AGENT_SCHEMA_VERSION);
  return database;
}

function readColumnContract(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
): Record<string, unknown> | undefined {
  const column = (
    database.prepare(`PRAGMA table_xinfo("${tableName}")`).all() as Array<Record<string, unknown>>
  ).find((candidate) => candidate.name === columnName);
  return column
    ? {
        dflt_value: column.dflt_value,
        hidden: column.hidden,
        name: column.name,
        notnull: column.notnull,
        pk: column.pk,
        type: column.type,
      }
    : undefined;
}
