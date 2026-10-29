import type { SqliteDatabaseFactKey } from "../sqlite-database-admission-record.js";
import type { PostgresCatalogFact } from "./postgres-catalog.js";

export type PostgresCapabilities = {
  serverMajor: number;
  serverEncoding: "UTF8";
  clientEncoding: "UTF8";
};

export type PostgresPhysicalFacts = {
  engine: "postgres";
  admissionId: string;
  store: string;
  namespace: string;
  storeId: string;
  version: number;
  capabilities: PostgresCapabilities;
  catalog: readonly PostgresCatalogFact[];
};

export const postgresPhysicalFactsKey: SqliteDatabaseFactKey<PostgresPhysicalFacts> = {
  name: "database.engine.schema",
  schemaDependent: true,
};
