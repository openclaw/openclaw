import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { publishSqliteDatabaseSchemaChange } from "./sqlite-database-admission.js";
import type { SqliteSchemaMarkers } from "./sqlite-pinned-read-snapshot.js";
import type { SqliteSchemaFacts } from "./sqlite-schema-admission.js";
import type { SqliteTempTrackingSchema } from "./sqlite-temp-generation-schema.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type SchemaScope = { key?: string; revision: number; users: number };
type SqliteSchemaScopeOwner = { scope?: SchemaScope; scopeRevision?: number };

const scopes = resolveGlobalSingleton(Symbol.for("openclaw.sqliteSchemaScopes"), () => {
  const byIdentity = new Map<string, SchemaScope>();
  const release = (scope: SchemaScope) => {
    scope.users -= 1;
    if (scope.users === 0 && scope.key && byIdentity.get(scope.key) === scope) {
      byIdentity.delete(scope.key);
    }
  };
  return { byIdentity, release, finalizer: new FinalizationRegistry(release) };
});

export function bindSqliteSchemaScope(
  database: DatabaseSync,
  owner: SqliteSchemaScopeOwner,
): SchemaScope {
  if (owner.scope) {
    return owner.scope;
  }
  const location = database.location();
  const key = location ? readDatabasePathIdentitySync(location).key : undefined;
  const scope = (key && scopes.byIdentity.get(key)) || { key, revision: 0, users: 0 };
  if (key) {
    scopes.byIdentity.set(key, scope);
  }
  scope.users += 1;
  owner.scope = scope;
  owner.scopeRevision = scope.revision;
  scopes.finalizer.register(database, scope, owner);
  return scope;
}

export function releaseSqliteSchemaScope(owner: SqliteSchemaScopeOwner): void {
  if (owner.scope) {
    scopes.finalizer.unregister(owner);
    scopes.release(owner.scope);
    owner.scope = undefined;
    owner.scopeRevision = undefined;
  }
}

export function publishSqliteSchemaChange(
  database: DatabaseSync,
  owner: SqliteSchemaScopeOwner,
): void {
  publishSqliteDatabaseSchemaChange(database);
  const scope = bindSqliteSchemaScope(database, owner);
  scope.revision += 1;
  owner.scopeRevision = scope.revision;
}

type SqliteReadRevision = {
  schema: SqliteSchemaFacts;
  mutationRevision: number;
};

export type SqliteReadOperationRevision = SqliteReadRevision & { writeRevision: number };

export type SqliteReadScopeRevision = Readonly<
  SqliteReadRevision &
    (
      | { snapshot: undefined; writeRevision: number }
      | { snapshot: object; writeRevision: undefined }
    )
>;

export type SchemaMutationListener = (observed?: SqliteSchemaMarkers) => void;

export type SqliteSchemaOwner = SqliteSchemaScopeOwner & {
  writable: boolean;
  admitted: boolean;
  revision: number;
  facts?: SqliteSchemaFacts;
  readDepth: number;
  mutationRevision: number;
  rollbackRevision: number;
  mutationDepth: number;
  transactionOpen: boolean;
  transactionSnapshot?: object;
  transactionMutationRevision?: number;
  transactionRead: boolean;
  transactionCatalogBound: boolean;
  nativeDepth: number;
  pendingSchema: boolean;
  schemaMutationRevision: number;
  settling: boolean;
  capturing: boolean;
  readRevision?: SqliteReadScopeRevision;
  transactionalSchema: boolean;
  transactionalTempSchema: boolean;
  transactionBaseFacts?: SqliteSchemaFacts;
  transactionalFacts: boolean;
  snapshot?: object;
  qualifiedSnapshot?: object;
  unmanagedSnapshots: Set<object>;
  iteratorFacts: boolean;
  authorizerActive: boolean;
  processRevision?: number;
  mutationListeners?: Set<SchemaMutationListener>;
  isolatedTempTables: Set<string>;
  installTempTrackingSchema?: (schema: SqliteTempTrackingSchema) => void;
};

export function observeSqliteTransactionState(
  database: DatabaseSync,
  owner: SqliteSchemaOwner,
): void {
  const inTransaction = database.isTransaction;
  if (owner.transactionOpen !== inTransaction) {
    if (owner.transactionOpen) {
      // A read error can roll back SQLite without passing through a tracked write.
      owner.mutationRevision += 1;
      owner.rollbackRevision += 1;
    }
    owner.transactionOpen = inTransaction;
    owner.transactionMutationRevision = undefined;
    owner.transactionSnapshot = undefined;
    owner.transactionRead = false;
    owner.transactionCatalogBound = false;
  }
}

export function finishSqliteReadScope(
  database: DatabaseSync,
  owner: SqliteSchemaOwner,
  wasTransaction: boolean,
  expiresRead: boolean,
  succeeded: boolean,
  openingMutationRevision?: number,
): void {
  const inTransaction = database.isTransaction;
  if (!succeeded && wasTransaction && !inTransaction) {
    owner.mutationRevision += 1;
    owner.rollbackRevision += 1;
  }
  owner.transactionOpen = inTransaction;
  if (!wasTransaction || !inTransaction) {
    owner.transactionMutationRevision = inTransaction ? openingMutationRevision : undefined;
  }
  if (wasTransaction !== inTransaction || expiresRead) {
    owner.transactionSnapshot = undefined;
    owner.transactionRead = false;
    owner.transactionCatalogBound = false;
  }
}
