import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts, runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

/** Install missing additive objects using the connection's admitted schema lifecycle. */
export function createSqliteSchemaEnsurer(
  schemaSql: () => string,
  objects: { tables: readonly string[]; indexes?: readonly string[] },
): (database: DatabaseSync) => void {
  const present = (database: DatabaseSync): boolean => {
    const facts = getAdmittedSqliteSchemaFacts(database);
    return (
      facts !== undefined &&
      objects.tables.every((table) => facts.tables.has(table)) &&
      (objects.indexes?.every((index) => facts.indexes.has(index)) ?? true)
    );
  };
  return (database) => {
    runSqliteReadOperationSync(database, () => {
      if (present(database)) {
        return;
      }
      const install = () => {
        // A standalone ensure refreshes again after acquiring its writer transaction.
        if (!present(database)) {
          database.exec(schemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
        }
      };
      if (database.isTransaction) {
        install();
      } else {
        runSqliteImmediateTransactionSync(database, install);
      }
    });
  };
}
