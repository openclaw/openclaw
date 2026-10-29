import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PostgresPhysicalFacts } from "./database-engine/physical-facts-contract.js";
import type { SqliteSchemaMarkers } from "./sqlite-pinned-read-snapshot.js";
import type { SqliteTempTrackingSchema } from "./sqlite-temp-generation-schema.js";

export type SqliteSchemaFacts = {
  readonly admissionId: string;
  readonly revision: number;
  readonly userVersion: number;
  readonly textEncoding: string;
  readonly schemaVersion: number;
  readonly tables: ReadonlySet<string>;
  readonly views: ReadonlySet<string>;
  readonly tableSql: ReadonlyMap<string, string | null>;
  readonly indexes: ReadonlySet<string>;
  readonly indexDefinitions: ReadonlyMap<string, { table: string; sql: string | null }>;
  readonly triggers: ReadonlyMap<string, { table: string; sql: string | null }>;
};

type SqliteReadRevision = {
  schema: SqliteSchemaFacts;
  mutationRevision: number;
};

export type PostgresReadSnapshotRevision = Readonly<{
  schema: PostgresPhysicalFacts;
  mutationRevision: number;
  snapshot: object;
  writeRevision: number;
}>;

export type SqliteReadOperationRevision =
  | (SqliteReadRevision & { snapshot?: undefined; writeRevision: number })
  | PostgresReadSnapshotRevision;

export type SqliteReadScopeRevision = Readonly<
  | (SqliteReadRevision &
      (
        | { snapshot: undefined; writeRevision: number }
        | { snapshot: object; writeRevision: undefined }
      ))
  | PostgresReadSnapshotRevision
>;

export type SchemaMutationListener = (observed?: SqliteSchemaMarkers) => void;

export type SqliteSchemaOwner = {
  admitted: boolean;
  revision: number;
  facts?: SqliteSchemaFacts;
  readDepth: number;
  mutationRevision: number;
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

export const sqliteSchemaOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSchemaFacts"),
  () => new WeakMap<DatabaseSync, SqliteSchemaOwner>(),
);

export function observeSqliteTransactionState(
  database: DatabaseSync,
  owner: SqliteSchemaOwner,
): void {
  const inTransaction = database.isTransaction;
  if (owner.transactionOpen !== inTransaction) {
    if (owner.transactionOpen) {
      // A read error can roll back SQLite without passing through a tracked write.
      owner.mutationRevision += 1;
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
