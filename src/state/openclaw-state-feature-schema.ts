import type { DatabaseSync } from "node:sqlite";
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
  endMarker?: string;
  includeEndMarker?: boolean;
  errorMessage?: string;
  operationLabel: string;
}): (options?: OpenClawStateDatabaseOptions) => void {
  const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, params.table, {
    endMarker: params.endMarker ?? "\n) STRICT;\n",
    includeEndMarker: params.includeEndMarker,
    errorMessage:
      params.errorMessage ?? `Canonical state schema markers are missing for ${params.table}`,
  });
  const ensuredDatabases = new WeakSet<DatabaseSync>();
  return (options = {}) => {
    const database = openOpenClawStateDatabase(options);
    if (ensuredDatabases.has(database.db)) {
      return;
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.exec(schema); // sqlite-allow-raw -- Canonical feature-local additive DDL only.
      },
      options,
      { operationLabel: params.operationLabel },
    );
    // Preserve successful wrapper-return timing, including nested savepoints.
    ensuredDatabases.add(database.db);
  };
}
