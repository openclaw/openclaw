import type { DatabaseSync } from "node:sqlite";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-maintenance-context.js";
import {
  readSqliteDatabaseWriteRevision,
  readSqliteDatabaseWriteTokenForPath,
} from "./sqlite-database-admission.js";
import {
  readSqliteNativeMutationRevision,
  registerSqliteSchemaMutationListener,
} from "./sqlite-schema-facts.js";

type TableChecks = { token: string; tables: Set<string> };
const maintenanceChecks = new WeakMap<
  OpenClawDatabaseMaintenanceScope,
  { committed: Map<string, Set<string>>; transactions: WeakMap<DatabaseSync, TableChecks> }
>();

/** Passing scoped checks belong to the offline owner and the existing physical write receipt. */
export function getMaintenanceSqliteTableChecks(database: DatabaseSync): Set<string> | undefined {
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (!scope?.ownsSchemaMaintenance || scope.sqliteIntegrityCheck !== "quick") {
    return undefined;
  }
  const mutation = readSqliteNativeMutationRevision(database);
  const location = database.location();
  if (
    mutation === undefined ||
    !location ||
    readSqliteDatabaseWriteRevision(database) === undefined
  ) {
    return undefined;
  }
  const token = readSqliteDatabaseWriteTokenForPath(location);
  if (token === undefined) {
    return undefined;
  }
  let checks = maintenanceChecks.get(scope);
  if (!checks) {
    checks = { committed: new Map(), transactions: new WeakMap() };
    maintenanceChecks.set(scope, checks);
  }
  if (!database.isTransaction) {
    let tables = checks.committed.get(token);
    if (!tables) {
      tables = new Set();
      checks.committed.set(token, tables);
    }
    return tables;
  }
  // Uncommitted proof never crosses handles or becomes committed proof on rollback.
  const transactionToken = `${token}:${mutation}`;
  let transaction = checks.transactions.get(database);
  if (!transaction) {
    const tables = new Set<string>();
    transaction = { token: transactionToken, tables };
    checks.transactions.set(database, transaction);
    scope.own(
      transaction,
      "shared-resources",
      registerSqliteSchemaMutationListener(database, () => tables.clear()),
    );
  } else if (transaction.token !== transactionToken) {
    transaction.token = transactionToken;
    transaction.tables.clear();
  }
  return transaction.tables;
}
