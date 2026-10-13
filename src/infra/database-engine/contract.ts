import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type { PostgresSyncConnection } from "../postgres-sync/connection.js";
import type { SqlConnection } from "../sql-connection.js";
import type { DatabaseEngineInput } from "./config.js";
import type { DatabaseEngineId } from "./registry.js";

export type EngineConnection = DatabaseSync | PostgresSyncConnection;

export type DatabaseErrorKind =
  | "constraint"
  | "busy"
  | "connection-lost"
  | "outcome-unknown"
  | "other";
export type StoreSchema = { id: string; version: number; sqlite: string; postgres?: string };
export type AdmittedStore = {
  anchor: DatabaseSync;
  schema: StoreSchema;
  input: DatabaseEngineInput;
  openSqlite: () => void;
  storeId?: string;
  namespace?: string;
};
type TransactionRecipes<Connection extends SqlConnection> = {
  write<T>(connection: Connection, operation: () => T): T;
  read<T>(connection: Connection, operation: () => T): T;
};
export interface DatabaseEngineAdapter<Connection extends SqlConnection = SqlConnection> {
  id: DatabaseEngineId;
  openConnection(store: AdmittedStore): Connection;
  kysely(connection: Connection): Kysely<unknown>;
  transactions: TransactionRecipes<Connection>;
  capabilities: { fullText: "fts5" | "tsvector" | null; vector: "sqlite-vec" | "pgvector" | null };
  schema: {
    bootstrap(store: AdmittedStore, connection: Connection): void;
    migrate(store: AdmittedStore, from: number): void;
  };
  classifyError(error: unknown): DatabaseErrorKind;
}
