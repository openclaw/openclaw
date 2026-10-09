import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SQLITE_CANONICAL_DEFINITIONS_KEY } from "../infra/bun-sqlite-library.js";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteSchemaCookie } from "../infra/sqlite-schema-contract.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema, normalizeSchemaSql } from "../infra/sqlite-schema-sql.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { classifyOpenClawAgentDatabaseReadError } from "./openclaw-agent-db-read-error.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

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
  () =>
    new WeakMap<
      DatabaseSync,
      { cookie: number; schema?: SqliteSchemaFacts; unregister: () => void }
    >(),
);
const canonicalContracts = resolveGlobalSingleton(
  Symbol.for("openclaw.agentCanonicalValidationSchemaContracts"),
  () => new Map<string, ReadonlyMap<string, string | null>>(),
);

export type PreparedCanonicalSessionValidationSchema = {
  schemaSql: string;
  definitions: ReadonlyMap<string, string | null>;
};

/** Capture existing canonical facts without constructing a comparison database on the host. */
export function captureCanonicalSessionValidationSchema():
  | PreparedCanonicalSessionValidationSchema
  | undefined {
  const definitions = canonicalContracts.get(OPENCLAW_AGENT_SCHEMA_SQL);
  return definitions
    ? {
        schemaSql: OPENCLAW_AGENT_SCHEMA_SQL,
        definitions: new Map(definitions),
      }
    : undefined;
}

/** Private worker requests carry expected definitions, never observed database schemas. */
export function adoptPreparedCanonicalSessionValidationSchema(
  contract: PreparedCanonicalSessionValidationSchema,
): void {
  if (
    contract.schemaSql === OPENCLAW_AGENT_SCHEMA_SQL &&
    !canonicalContracts.has(contract.schemaSql)
  ) {
    canonicalContracts.set(contract.schemaSql, new Map(contract.definitions));
  }
}

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

function expectedDefinitions(): ReadonlyMap<string, string | null> {
  const cached = canonicalContracts.get(OPENCLAW_AGENT_SCHEMA_SQL);
  if (cached) {
    return cached;
  }
  const sourceHash = createHash("sha256").update(OPENCLAW_AGENT_SCHEMA_SQL).digest("hex");
  const inherited: unknown = getEnvironmentData(SQLITE_CANONICAL_DEFINITIONS_KEY);
  if (
    isRecord(inherited) &&
    inherited.format === 1 &&
    inherited.pid === process.pid &&
    inherited.sourceHash === sourceHash &&
    inherited.definitions instanceof Map &&
    [...inherited.definitions].every(
      ([name, sql]) => typeof name === "string" && (sql === null || typeof sql === "string"),
    )
  ) {
    const definitions = new Map(inherited.definitions);
    canonicalContracts.set(OPENCLAW_AGENT_SCHEMA_SQL, definitions);
    return definitions;
  }
  const database = openNodeSqliteDatabase(":memory:");
  let definitions: Map<string, string | null>;
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
    definitions = readDefinitions(database);
  } finally {
    database.close();
  }
  // Publish only newly constructed canonical facts, never target rows or a prior code generation's map.
  setEnvironmentData(SQLITE_CANONICAL_DEFINITIONS_KEY, {
    format: 1,
    pid: process.pid,
    sourceHash,
    definitions: new Map(definitions),
  });
  canonicalContracts.set(OPENCLAW_AGENT_SCHEMA_SQL, definitions);
  return definitions;
}

/** Require the exact invalidation group before an empty pending set can certify readiness. */
export function assertCanonicalSessionValidationSchema(database: DatabaseSync): void {
  const schema = getAdmittedSqliteSchemaFacts(database);
  const cookie = schema?.schemaVersion ?? readSqliteSchemaCookie(database);
  if (typeof cookie !== "number") {
    throw new Error("Session canonical validation schema version is unavailable");
  }
  const cached = validatedSchemas.get(database);
  if (cached && (schema ? cached.schema === schema : !cached.schema && cached.cookie === cookie)) {
    return;
  }
  cached?.unregister();
  validatedSchemas.delete(database);
  const expected = expectedDefinitions();
  const actual = readDefinitions(database, schema);
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
  if (!schema && readSqliteSchemaCookie(database) !== cookie) {
    throw new Error("Session canonical validation schema changed during admission; retry the read");
  }
  // Admitted handles own DDL/rollback invalidation; unmanaged readers only retain committed cookies.
  if (schema || !database.isTransaction) {
    rememberCanonicalSessionValidationSchema(database, cookie, schema);
  }
}

/** Writable admission may carry this assertion from its validated physical sibling. */
export function adoptCanonicalSessionValidationSchema(database: DatabaseSync): void {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    throw new Error("Canonical schema handoff requires admitted schema facts");
  }
  rememberCanonicalSessionValidationSchema(database, schema.schemaVersion, schema);
}

function rememberCanonicalSessionValidationSchema(
  database: DatabaseSync,
  cookie: number,
  schema?: SqliteSchemaFacts,
): void {
  validatedSchemas.get(database)?.unregister();
  const unregister = registerNodeSqliteDisposeCallback(database, () => {
    validatedSchemas.delete(database);
    unregister();
  });
  validatedSchemas.set(database, { cookie, schema, unregister });
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
