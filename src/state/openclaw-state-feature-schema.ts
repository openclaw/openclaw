import type { DatabaseSync } from "node:sqlite";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

/** Prepare canonical DDL without opening a database; each feature keeps its own handle cache. */
export function createOpenClawStateSchemaEnsurer(params: {
  table: string;
  additionalTables?: readonly string[];
  indexes?: readonly string[];
  endMarker?: string;
  operationLabel: string;
}): (options?: OpenClawStateDatabaseOptions) => void {
  const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, params.table, {
    endMarker: params.endMarker ?? "\n) STRICT;\n",
    errorMessage: `Canonical state schema markers are missing for ${params.table}`,
  });
  // Redundant DDL still revokes shared integrity proof, including an exec launch
  // guard retained while a sibling feature performs its first native read.
  const ensure = createSqliteSchemaEnsurer(() => schema, {
    tables: [params.table, ...(params.additionalTables ?? [])],
    indexes: params.indexes,
  });
  const ensuredDatabases = new WeakSet<DatabaseSync>();
  return (options = {}) => {
    const database = openOpenClawStateDatabase(options);
    if (ensuredDatabases.has(database.db)) {
      return;
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        ensure(db);
      },
      options,
      { operationLabel: params.operationLabel },
    );
    // Preserve successful wrapper-return timing, including nested savepoints.
    ensuredDatabases.add(database.db);
  };
}
