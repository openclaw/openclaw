import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const existingAgentLeaseSchema = ["schema_meta", "state_leases", "agent_database_leases"]
  .map((table) =>
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table, {
      endMarker: ") STRICT;",
      errorMessage: "Existing agent lease schema is unavailable.",
    }),
  )
  .join("\n");

export function withExistingAgentLeaseWrite<T>(
  maintenance: OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions,
  operation: (db: DatabaseSync) => T,
): T {
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      maintenance.assertOwnedInTransaction(db);
      const result = operation(db);
      maintenance.assertOwnedInTransaction(db);
      return result;
    },
    options,
    {
      operationLabel: "agent.database.maintenance.admission",
      schemaSql: existingAgentLeaseSchema,
      busyTimeoutMs: 0,
    },
  );
}
