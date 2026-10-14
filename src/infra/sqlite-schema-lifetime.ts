import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteDatabaseSchemaRevision,
  publishSqliteDatabaseSchemaChange,
} from "./sqlite-database-admission.js";
import { invalidateTrackedSqliteSchemaFacts as invalidate } from "./sqlite-schema-admission.js";
import type { SqliteSchemaOwner as SchemaOwner } from "./sqlite-schema-scope.js";

export function observeSchemaLifetime(
  database: DatabaseSync,
  owner: SchemaOwner,
  snapshot: object | undefined,
): boolean {
  if (owner.snapshot && owner.snapshot !== snapshot) {
    invalidate(owner);
    owner.snapshot = undefined;
    owner.qualifiedSnapshot = undefined;
  }
  const processRevision = getSqliteDatabaseSchemaRevision(database);
  const scopeChanged =
    owner.processRevision !== undefined && owner.processRevision !== processRevision;
  if (
    scopeChanged &&
    owner.facts &&
    !owner.transactionalSchema &&
    ((database.isTransaction && owner.transactionCatalogBound) ||
      (snapshot && owner.qualifiedSnapshot === snapshot))
  ) {
    // An active SQLite snapshot keeps the catalog it admitted, even after a sibling publishes DDL.
    owner.transactionalFacts ||= database.isTransaction;
    owner.snapshot = snapshot;
    return false;
  }
  owner.processRevision = processRevision;
  if (scopeChanged) {
    invalidate(owner);
  }
  if (
    (owner.transactionalSchema || owner.transactionalTempSchema || owner.transactionalFacts) &&
    !database.isTransaction
  ) {
    if (owner.transactionalSchema) {
      publishSqliteDatabaseSchemaChange(database);
    }
    invalidate(owner);
    owner.transactionalSchema = false;
    owner.transactionalTempSchema = false;
    owner.transactionalFacts = false;
  }
  return scopeChanged;
}
