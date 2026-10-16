import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Client } from "pg";
import type { PostgresCatalogFact } from "./postgres-catalog.js";
import type { DatabaseEngineInput } from "./types.js";

export type PortRow = Record<string, SQLInputValue>;
export type PortTable = {
  name: string;
  columns: readonly { name: string; type: string }[];
  pk: readonly string[];
  identities: readonly { column: string; autoIncrement: boolean }[];
};
type PortSchema = {
  tables: readonly PortTable[];
  sqlite: string;
  preData: string;
  postData: string;
  expectedCatalog: readonly PostgresCatalogFact[];
  triggers?: readonly { name: string; table: string; sql: string }[];
  projections?: readonly {
    tables: readonly string[];
    rebuild(target: PortEndpoint): void | Promise<void>;
  }[];
};
export type PortDescriptor = PortSchema & {
  id: string;
  version: number;
  minimumPostgresVersion: number;
  fragments?: readonly (PortSchema & { id: string; dependencies: readonly string[] })[];
  /** Populated from the admitted source, never from the configured feature set. */
  activeFragments?: readonly string[];
  inspectSqliteSource?: (db: DatabaseSync) => {
    version: number;
    migrationRequired: boolean;
    pendingColumns: Readonly<Record<string, readonly string[]>>;
  };
  /** Caller supplies an exclusively owned private copy, never the live source. */
  migrateSqliteSource?: (path: string, sourceVersion: number) => void | Promise<void>;
  admit?: (path: string, input?: DatabaseEngineInput) => void | Promise<void>;
  derive?: Readonly<Record<string, (row: PortRow) => PortRow>>;
};
export type PortEndpoint =
  | { engine: "sqlite"; db: DatabaseSync }
  | { engine: "postgres"; db: Client; namespace: string };
