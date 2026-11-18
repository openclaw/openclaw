import { randomUUID } from "node:crypto";
import type { EngineConnection, PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  getOrLoadSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
} from "../sqlite-database-admission.js";
import type { StoreSchema } from "./contract.js";
import {
  postgresPhysicalFactsKey as admissionKey,
  type PostgresPhysicalFacts,
} from "./physical-facts-contract.js";
import type { PostgresCatalogFact } from "./postgres-catalog.js";
import {
  admitPostgresCapabilities,
  getAdmittedPostgresSchema,
  postgresSchemaHash,
  readPostgresSchema,
  recordPostgresSchema,
  verifyPostgresSchema,
  withPostgresSearchExtensions,
  retainPostgresSchema,
} from "./postgres-schema.js";

export type { PostgresPhysicalFacts } from "./physical-facts-contract.js";
const recovery =
  "Use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.";

export function getPostgresPhysicalFacts(db: EngineConnection, options?: { refresh?: boolean }) {
  return getSqliteDatabaseAdmission(db, admissionKey, options);
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
  requireSealedSchema?: boolean;
}): PostgresPhysicalFacts {
  const retained = getPostgresPhysicalFacts(params.db);
  if (retained) {
    if (
      retained.version !== params.version ||
      retained.storeId !== params.storeId ||
      retained.namespace !== params.namespace ||
      retained.store !== params.store
    ) {
      throw new Error(`PostgreSQL metadata identity or version mismatch. ${recovery}`);
    }
    if (params.requireSealedSchema) {
      const schema = params.schema;
      const admitted = getAdmittedPostgresSchema(params.db);
      // Dynamic extensions belong to the installed schema, not the caller's base definition.
      if (
        !schema ||
        !retained.schemaHash ||
        retained.schemaHash !==
          postgresSchemaHash(
            { ...schema, searchExtensions: admitted?.searchExtensions },
            retained.catalog,
          )
      ) {
        throw new Error(
          `Read-only PostgreSQL admission requires a matching schema seal. ${recovery}`,
        );
      }
    }
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
  let schemaHash: string | undefined;
  if (params.schema) {
    const schema = withPostgresSearchExtensions(params.schema, snapshot);
    if (params.recordSchema) {
      schemaHash = recordPostgresSchema(params.db, params.namespace, schema, snapshot);
    } else {
      schemaHash = verifyPostgresSchema(
        params.db,
        params.namespace,
        schema,
        snapshot,
        params.preserveSchemaSeal,
        params.requireSealedSchema,
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
    schemaHash,
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
  schema: StoreSchema,
): void {
  publishSqliteDatabaseAdmission(db, admissionKey, {
    ...facts,
    admissionId: randomUUID(),
    catalog,
    schemaHash: postgresSchemaHash(schema, catalog),
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
