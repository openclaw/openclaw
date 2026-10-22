import type { DatabaseSync } from "node:sqlite";
import { requireNativeDatabaseFile } from "./database-engine/physical-facts.js";
import type { EngineConnection } from "./sql-connection.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { getAdmittedSqliteSchemaFacts, runSqliteReadOperationSync } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

/** Install missing additive objects using the connection's admitted schema lifecycle. */
export function createSqliteSchemaEnsurer(
  schemaSql: () => string,
  objects: { tables: readonly string[]; indexes?: readonly string[] },
): (database: EngineConnection) => void {
  const present = (database: DatabaseSync): boolean => {
    const facts = getAdmittedSqliteSchemaFacts(database);
    return (
      facts !== undefined &&
      objects.tables.every((table) => facts.tables.has(table)) &&
      (objects.indexes?.every((index) => facts.indexes.has(index)) ?? true)
    );
  };
  return (database) => {
    if (isPostgresSqlConnection(database)) {
      requireNativeDatabaseFile("postgres", "repair");
    }
    runSqliteReadOperationSync(database, () => {
      if (present(database)) {
        return;
      }
      const install = () => database.exec(schemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
      if (database.isTransaction) {
        install();
      } else {
        runSqliteImmediateTransactionSync(database, install);
      }
    });
  };
}
