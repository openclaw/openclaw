import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type { SqlConnection } from "../sql-connection.js";
import type { SearchSchema, SearchStore, StoreSearchCapabilities } from "./search.js";
import type { DatabaseEngineId, DatabaseEngineInput } from "./types.js";

export type { EngineConnection } from "../sql-connection.js";

export type DatabaseErrorKind =
  | "constraint"
  | "busy"
  | "connection-lost"
  | "outcome-unknown"
  | "other";
export type PostgresSchemaFragment = {
  id: string;
  tables: readonly string[];
  sql: string;
  dependencies: readonly string[];
  activation: "first-use" | "version-additive";
};
type PostgresSchemaDefinition = {
  postgres: string;
  postgresFragments?: readonly PostgresSchemaFragment[];
};
export type StoreSchema = {
  id: string;
  version: number;
  sqlite: string;
  postgres?: string;
  /** Consecutive destinations carry generated DDL for both sides of the migration. */
  postgresMigrations?: readonly {
    version: number;
    sql: string;
    fromSchema: PostgresSchemaDefinition;
    schema: PostgresSchemaDefinition;
  }[];
  postgresFragments?: readonly PostgresSchemaFragment[];
};
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
  /** @experimental Bind engine search operations to an already admitted store. */
  search?: (store: SearchStore, schema: SearchSchema) => StoreSearchCapabilities;
  schema: {
    bootstrap(store: AdmittedStore, connection: Connection): void;
    migrate(store: AdmittedStore, from: number, connection: Connection): void;
  };
  classifyError(error: unknown): DatabaseErrorKind;
}
