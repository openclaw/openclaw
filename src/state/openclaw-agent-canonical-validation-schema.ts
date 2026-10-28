import type { DatabaseSync } from "node:sqlite";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { readSqliteSchemaCookie } from "../infra/sqlite-schema-contract.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema, normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { classifyOpenClawAgentDatabaseReadError } from "./openclaw-agent-db-read-error.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export { canonicalSessionValidationSchemaSql } from "./openclaw-agent-schema-history.js";

const validationTables = new Set([
  "session_nodes",
  "session_windows",
  "session_key_contract",
  "session_canonical_validation_pending",
]);
const definitionsSql = `SELECT name, sql FROM main.sqlite_schema
  WHERE name = 'session_canonical_validation_pending'
    OR (type = 'trigger' AND tbl_name IN (
      'session_nodes', 'session_windows', 'session_key_contract', 'session_canonical_validation_pending'
    ))`;
const validatedSchemas = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCanonicalValidationSchemas"),
  () => new WeakMap<DatabaseSync, { cookie: number; schema?: SqliteSchemaFacts }>(),
);
// Canonical writers no longer install validation triggers; only the pending table is expected.
const expectedDefinitions = new Map([
  [
    "session_canonical_validation_pending",
    normalizeSchemaSql(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_canonical_validation_pending"),
    ),
  ],
]);

function readDefinitions(
  database: DatabaseSync,
  schema?: SqliteSchemaFacts,
): Map<string, string | null> {
  const definitions = new Map<string, string | null>();
  const pending = "session_canonical_validation_pending";
  const rows = schema
    ? [
        ...(schema.tableSql.has(pending)
          ? [{ name: pending, sql: schema.tableSql.get(pending) }]
          : []),
        ...Array.from(schema.triggers).flatMap(([name, trigger]) =>
          name === pending || validationTables.has(trigger.table)
            ? [{ name, sql: trigger.sql }]
            : [],
        ),
      ]
    : database.prepare(definitionsSql).all(); // sqlite-allow-raw -- Native schema definitions.
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      throw new Error("Session canonical validation schema has an unreadable definition");
    }
    definitions.set(row.name, normalizeSchemaSql(row.sql));
  }
  return definitions;
}

/** Require the canonical admission schema before consuming its pending work. */
export function assertCanonicalSessionValidationSchema(database: EngineConnection): void {
  if (isPostgresSqlConnection(database)) {
    const facts = getPostgresPhysicalFacts(database);
    if (facts?.store !== "agent" || facts.version < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
      throw new Error("Session canonical validation requires current PostgreSQL agent admission");
    }
    return;
  }
  const schema = getAdmittedSqliteSchemaFacts(database);
  const cookie = schema?.schemaVersion ?? readSqliteSchemaCookie(database);
  if (typeof cookie !== "number") {
    throw new Error("Session canonical validation schema version is unavailable");
  }
  const cached = validatedSchemas.get(database);
  if (cached && (schema ? cached.schema === schema : !cached.schema && cached.cookie === cookie)) {
    return;
  }
  validatedSchemas.delete(database);
  const actual = readDefinitions(database, schema);
  for (const name of new Set([...expectedDefinitions.keys(), ...actual.keys()])) {
    if (expectedDefinitions.get(name) !== actual.get(name)) {
      throw classifyOpenClawAgentDatabaseReadError(
        database,
        new Error(
          `Session canonical validation schema is missing or drifted: ${name}; run openclaw doctor --fix with the compatible build.`,
        ),
      );
    }
  }
  // Admitted handles own DDL/rollback invalidation; unmanaged readers only retain committed cookies.
  if (schema || !database.isTransaction) {
    validatedSchemas.set(database, { cookie, schema });
  }
}

/** Writable admission may carry this assertion from its validated physical sibling. */
export function adoptCanonicalSessionValidationSchema(database: EngineConnection): void {
  if (isPostgresSqlConnection(database)) {
    assertCanonicalSessionValidationSchema(database);
    return;
  }
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("Canonical schema handoff requires admitted schema facts");
  }
  validatedSchemas.set(database, { cookie: schema.schemaVersion, schema });
}
