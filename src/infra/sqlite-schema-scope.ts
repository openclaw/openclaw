import type { DatabaseSync } from "node:sqlite";
import type { SqliteSchemaMarkers } from "./sqlite-pinned-read-snapshot.js";
import type { SqliteSchemaFacts } from "./sqlite-schema-admission.js";
import type { SqliteTempTrackingSchema } from "./sqlite-temp-generation-schema.js";

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

export type SqliteSchemaOwner = {
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
