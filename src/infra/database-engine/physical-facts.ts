import { randomUUID } from "node:crypto";
import type { EngineConnection, PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  getOrLoadSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseFactKey,
} from "../sqlite-database-admission.js";
import type { StoreSchema } from "./contract.js";
import type { PostgresCatalogFact } from "./postgres-catalog.js";
import {
  admitPostgresCapabilities,
  readPostgresSchema,
  recordPostgresSchema,
  verifyPostgresSchema,
  withPostgresSearchExtensions,
  retainPostgresSchema,
  type PostgresCapabilities,
} from "./postgres-schema.js";

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
const recovery =
  "Use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.";
const admissionKey: SqliteDatabaseFactKey<PostgresPhysicalFacts> = {
  name: "database.engine.schema",
  schemaDependent: true,
};

export function getPostgresPhysicalFacts(db: EngineConnection) {
  return getSqliteDatabaseAdmission(db, admissionKey);
}

/** Operator projections consume admission evidence without opening or probing a store. */
export function getPostgresPhysicalFactsForPath(path: string) {
  return getOrLoadSqliteDatabaseAdmissionForPath(path, admissionKey, () => undefined);
}

/** Retain PostgreSQL admission facts on its admitted connection. */
export function admitPostgresPhysicalFacts(params: {
  db: PostgresSqlConnection;
  namespace: string;
  storeId: string;
  store: string;
  version: number;
  schema?: StoreSchema;
  recordSchema?: boolean;
  preserveSchemaSeal?: boolean;
}): PostgresPhysicalFacts {
  const retained = getPostgresPhysicalFacts(params.db);
  if (retained) {
    return retained;
  }
  const capabilities = admitPostgresCapabilities(params.db);
  let snapshot;
  try {
    snapshot = readPostgresSchema(params.db, params.namespace, params.store);
  } catch (error) {
    throw new Error(`Cannot read PostgreSQL catalog or metadata. ${recovery}`, { cause: error });
  }
  const { metadata: row, catalog } = snapshot;
  if (row.version !== params.version || row.store_id !== params.storeId) {
    throw new Error(`PostgreSQL metadata identity or version mismatch. ${recovery}`);
  }
  if (params.schema) {
    const schema = withPostgresSearchExtensions(params.schema, snapshot);
    if (params.recordSchema) {
      recordPostgresSchema(params.db, params.namespace, schema, snapshot);
    } else {
      verifyPostgresSchema(
        params.db,
        params.namespace,
        schema,
        snapshot,
        params.preserveSchemaSeal,
      );
    }
    retainPostgresSchema(params.db, schema);
  }
  const facts: PostgresPhysicalFacts = {
    engine: "postgres",
    admissionId: randomUUID(),
    store: params.store,
    namespace: params.namespace,
    storeId: row.store_id,
    version: row.version,
    capabilities,
    catalog,
  };
  publishSqliteDatabaseAdmission(params.db, admissionKey, facts);
  return facts;
}

export function publishPostgresSearchExtensionFacts(
  db: PostgresSqlConnection,
  facts: PostgresPhysicalFacts,
  catalog: readonly PostgresCatalogFact[],
): void {
  publishSqliteDatabaseAdmission(db, admissionKey, {
    ...facts,
    admissionId: randomUUID(),
    catalog,
  });
}

export function requireNativeDatabaseFile(
  engine: "postgres",
  operation: "integrity" | "repair" | "file-snapshot",
): never;
export function requireNativeDatabaseFile(
  engine: "sqlite" | "postgres",
  operation: "integrity" | "repair" | "file-snapshot",
): void;
export function requireNativeDatabaseFile(
  engine: "sqlite" | "postgres",
  operation: "integrity" | "repair" | "file-snapshot",
): void {
  if (engine === "postgres") {
    throw new Error(
      `PostgreSQL cannot use SQLite ${operation}; stop the Gateway and back up/restore the PostgreSQL schema with its matching anchor (P3-6 export support pending).`,
    );
  }
}
