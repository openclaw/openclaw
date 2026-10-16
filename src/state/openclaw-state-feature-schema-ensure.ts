import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { ensureStatePostgresFragment } from "./openclaw-state-db-engine.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "./openclaw-state-feature-schema.js";

/** Prepare canonical DDL without opening a database; each feature keeps its own handle cache. */
export function createOpenClawStateSchemaEnsurer(params: {
  table: string;
  additionalTables?: readonly string[];
  indexes?: readonly string[];
  endMarker?: string;
  operationLabel: string;
}): (options?: OpenClawStateDatabaseOptions) => void {
  const schema = getOpenClawStateFeatureSchemaSql(params.table, {
    endMarker: params.endMarker ?? "\n) STRICT;\n",
    errorMessage: `Canonical state schema markers are missing for ${params.table}`,
  });
  // Redundant DDL still revokes shared integrity proof, including an exec launch
  // guard retained while a sibling feature performs its first native read.
  const ensure = createSqliteSchemaEnsurer(() => schema, {
    tables: [params.table, ...(params.additionalTables ?? [])],
    indexes: params.indexes,
  });
  const ensuredDatabases = new WeakSet<EngineConnection>();
  return (options = {}) => {
    const database = openOpenClawStateDatabase(options);
    if (!isPostgresSqlConnection(database.db) && ensuredDatabases.has(database.db)) {
      return;
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (isPostgresSqlConnection(db)) {
          ensureStatePostgresFragment(db, params.table);
        } else {
          ensure(db);
        }
      },
      options,
      { operationLabel: params.operationLabel },
    );
    // Preserve successful wrapper-return timing, including nested savepoints.
    ensuredDatabases.add(database.db);
  };
}
