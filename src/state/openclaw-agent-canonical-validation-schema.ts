import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteSchemaCookie } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema, normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { classifyOpenClawAgentDatabaseReadError } from "./openclaw-agent-db-read-error.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const definitionsSql = `SELECT name, sql FROM main.sqlite_schema
  WHERE name = 'session_canonical_validation_pending'
    OR (type = 'trigger' AND tbl_name IN (
      'session_nodes', 'session_windows', 'session_key_contract', 'session_canonical_validation_pending'
    ))`;
const validatedSchemas = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCanonicalValidationSchemas"),
  () => new WeakMap<DatabaseSync, { cookie: number; unregister: () => void }>(),
);

function readDefinitions(database: DatabaseSync): Map<string, string | null> {
  const definitions = new Map<string, string | null>();
  const rows =
    // sqlite-allow-raw -- Read canonical schema definitions before admitting ordinary queries.
    database.prepare(definitionsSql).all();
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      throw new Error("Session canonical validation schema has an unreadable definition");
    }
    definitions.set(row.name, normalizeSchemaSql(row.sql));
  }
  return definitions;
}

function expectedDefinitions(): Map<string, string | null> {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.agentCanonicalValidationSchemaDefinitions"),
    () => {
      const database = openNodeSqliteDatabase(":memory:");
      try {
        // sqlite-allow-raw -- Bootstrap the canonical DDL in an isolated schema comparison database.
        database.exec(
          [
            extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_nodes"),
            extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_windows"),
            extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_key_contract", {
              endMarker: "CREATE TABLE IF NOT EXISTS session_windows (",
              includeEndMarker: false,
            }),
            canonicalSessionValidationSchemaSql(),
          ].join("\n"),
        );
        return readDefinitions(database);
      } finally {
        database.close();
      }
    },
  );
}

/** Require the exact invalidation group before an empty pending set can certify readiness. */
export function assertCanonicalSessionValidationSchema(database: DatabaseSync): void {
  const cookie = readSqliteSchemaCookie(database);
  if (typeof cookie !== "number") {
    throw new Error("Session canonical validation schema version is unavailable");
  }
  const cached = validatedSchemas.get(database);
  if (cached?.cookie === cookie) {
    return;
  }
  cached?.unregister();
  validatedSchemas.delete(database);
  const expected = expectedDefinitions();
  const actual = readDefinitions(database);
  for (const name of new Set([...expected.keys(), ...actual.keys()])) {
    if (expected.get(name) !== actual.get(name)) {
      throw classifyOpenClawAgentDatabaseReadError(
        database,
        new Error(
          `Session canonical validation schema is missing or drifted: ${name}; run openclaw doctor --fix with the compatible build.`,
        ),
      );
    }
  }
  if (readSqliteSchemaCookie(database) !== cookie) {
    throw new Error("Session canonical validation schema changed during admission; retry the read");
  }
  // Transactional DDL can roll back and reuse its cookie for another schema.
  if (!database.isTransaction) {
    const unregister = registerNodeSqliteDisposeCallback(database, () => {
      validatedSchemas.delete(database);
      unregister();
    });
    validatedSchemas.set(database, { cookie, unregister });
  }
}

/** The schema owner installs this complete group before seeding pending keys. */
export function canonicalSessionValidationSchemaSql(schema = OPENCLAW_AGENT_SCHEMA_SQL): string {
  return extractSqliteTableSchema(schema, "session_canonical_validation_pending", {
    endMarker: "CREATE TABLE IF NOT EXISTS conversations (",
    includeEndMarker: false,
  });
}

/** Historical migration preflights cannot require the schema-21 validation projection. */
export function withoutCanonicalSessionValidationSchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_canonical_validation_pending (")) {
    return schema;
  }
  return schema.replace(canonicalSessionValidationSchemaSql(schema), "");
}
