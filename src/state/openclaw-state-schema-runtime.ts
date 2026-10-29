import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  DOCTOR_OWNED_STATE_TABLES,
  FIRST_USE_STATE_INDEXES,
  FIRST_USE_STATE_TABLES,
  LAZY_ADDITIVE_STATE_INDEXES,
  LAZY_ADDITIVE_STATE_TABLES,
} from "./openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const runtimeSchemaCache = new Map<string, string>();

/** Project canonical SQL to the tables the shared runtime may create during this open. */
export function getOpenClawStateRuntimeSchema(options: {
  includeVersionLazyAdditiveTables: boolean;
  includeAgentDeletionJournal?: boolean;
}): string {
  const { includeVersionLazyAdditiveTables, includeAgentDeletionJournal = true } = options;
  const key = `${includeVersionLazyAdditiveTables}:${includeAgentDeletionJournal}`;
  const cached = runtimeSchemaCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let schema = OPENCLAW_STATE_SCHEMA_SQL;
  const omittedTables = [
    ...(includeVersionLazyAdditiveTables ? FIRST_USE_STATE_TABLES : LAZY_ADDITIVE_STATE_TABLES),
    ...(includeAgentDeletionJournal ? [] : DOCTOR_OWNED_STATE_TABLES),
  ];
  const omittedIndexes = includeVersionLazyAdditiveTables
    ? FIRST_USE_STATE_INDEXES
    : LAZY_ADDITIVE_STATE_INDEXES;
  for (const tableName of omittedTables) {
    schema = schema.replace(
      extractSqliteTableSchema(schema, tableName, {
        errorMessage: `lazy additive state schema block is missing for ${tableName}`,
      }),
      "",
    );
  }
  for (const indexName of omittedIndexes) {
    const plainStart = schema.indexOf(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    const uniqueStart = schema.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}`);
    const start = plainStart >= 0 ? plainStart : uniqueStart;
    const end = start >= 0 ? schema.indexOf(";", start) : -1;
    if (start < 0 || end < 0) {
      throw new Error(`lazy additive state schema index is missing for ${indexName}`);
    }
    schema = `${schema.slice(0, start)}${schema.slice(end + 1)}`;
  }
  runtimeSchemaCache.set(key, schema);
  return schema;
}
