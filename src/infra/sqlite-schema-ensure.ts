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
): (
  database: EngineConnection,
  runWrite?: (install: (database: EngineConnection) => void) => void,
) => void {
  const present = (database: DatabaseSync): boolean => {
    const facts = getAdmittedSqliteSchemaFacts(database);
    return (
      facts !== undefined &&
      objects.tables.every((table) => facts.tables.has(table)) &&
      (objects.indexes?.every((index) => facts.indexes.has(index)) ?? true)
    );
  };
  return (database, runWrite) => {
    if (isPostgresSqlConnection(database)) {
      requireNativeDatabaseFile("postgres", "repair");
    }
    runSqliteReadOperationSync(database, () => {
      if (present(database)) {
        return;
      }
      const install = (db: EngineConnection) => db.exec(schemaSql()); // sqlite-allow-raw -- Canonical additive DDL only.
      if (runWrite) {
        runWrite(install);
      } else if (database.isTransaction) {
        install(database);
      } else {
        runSqliteImmediateTransactionSync(database, () => install(database));
      }
    });
  };
}
