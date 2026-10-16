import type { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import type { EngineConnection, SqlConnection } from "../sql-connection.js";
import type { PortDescriptor } from "./port-types.js";
import type { FullTextCapability, TextIndex, TextIndexDefinition } from "./text-contract.js";
import type { DatabaseEngineId, DatabaseEngineInput } from "./types.js";
import type { VectorCapability, VectorIndex } from "./vector-contract.js";

export type { EngineConnection } from "../sql-connection.js";

/** @experimental Existing admitted native handle or admitted worker-store descriptor. */
export type SearchStore = EngineConnection | { databasePath: string; input?: DatabaseEngineInput };
/** @experimental Feature-owned declarations of the existing derived indexes. */
export type SearchSchema = {
  text?: Record<string, TextIndexDefinition>;
  vector?: Record<string, Omit<VectorIndex, "store">>;
  /** Selected by the memory owner only for the explicit provider: "none" setting. */
  mode?: "keyword-only";
  /** Schema where the operator installed the required PostgreSQL extensions. */
  extensionSchema?: string;
};
/** @experimental Null means unavailable; diagnostics name the required next step. */
export type StoreSearchCapabilities = {
  fullText: FullTextCapability | null;
  vector: VectorCapability | null;
  text: Record<string, TextIndex>;
  vectors: Record<string, VectorIndex>;
  diagnostics: readonly string[];
  /** Rebuild derived PostgreSQL search state inside the owning writer transaction. */
  rebuild?: () => void;
};

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
    /** Exact predecessor export needed before Doctor may advance this family. */
    backup?: PortDescriptor;
  }[];
  postgresFragments?: readonly PostgresSchemaFragment[];
  search?: SearchSchema;
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
