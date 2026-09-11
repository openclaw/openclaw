import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Source process ownership cannot survive reuse of a copied OpenClaw database. */
export function clearOpenClawStateCopyLeases(database: DatabaseSync): void {
  const queries = getNodeSqliteKysely<Pick<DB, "agent_database_leases" | "state_leases">>(database);
  runSqliteImmediateTransactionSync(database, () => {
    for (const table of ["agent_database_leases", "state_leases"] as const) {
      if (tableExists(database, table)) {
        executeSqliteQuerySync(database, queries.deleteFrom(table));
      }
    }
  });
}
