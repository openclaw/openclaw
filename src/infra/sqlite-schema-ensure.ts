import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

/** Cache additive DDL only after its owning transaction commits. */
export function createSqliteSchemaEnsurer(schemaSql: () => string) {
  const committed = new WeakSet<DatabaseSync>();
  return {
    recordCommitted(this: void, database: DatabaseSync): void {
      committed.add(database);
    },
    ensure(this: void, database: DatabaseSync): boolean {
      if (committed.has(database)) {
        return false;
      }
      const install = () => {
        database.exec(schemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
      };
      if (database.isTransaction) {
        install();
        return true;
      }
      runSqliteImmediateTransactionSync(database, install);
      committed.add(database);
      return false;
    },
  };
}
