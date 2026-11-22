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
import { withPostgresSchemaAdmissionRetry } from "./openclaw-state-postgres-admission.js";

/** Prepare canonical DDL without opening a database; admission owns schema presence. */
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
  const ensure = createSqliteSchemaEnsurer(() => schema, {
    tables: [params.table, ...(params.additionalTables ?? [])],
    indexes: params.indexes,
  });
  return (options = {}) => {
    const { db } = openOpenClawStateDatabase(options);
    const runWrite = (install: (database: EngineConnection) => void) =>
      runOpenClawStateWriteTransaction(
        ({ db: txDb }) => {
          if (isPostgresSqlConnection(txDb)) {
            ensureStatePostgresFragment(txDb, params.table);
          } else {
            install(txDb);
          }
        },
        options,
        { operationLabel: params.operationLabel },
      );
    if (isPostgresSqlConnection(db)) {
      // This transaction owns only schema installation, so rollback makes replay safe.
      withPostgresSchemaAdmissionRetry(db, () => runWrite(ensure));
    } else {
      ensure(db, runWrite);
    }
  };
}
