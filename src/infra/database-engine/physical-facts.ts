import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EngineConnection, PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../sqlite-database-admission.js";
import { assertEngineStoreExecutionAllowed } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import {
  assertPostgresCatalog,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "./postgres-catalog.js";
import {
  admitPostgresCapabilities,
  readPostgresSchema,
  recordPostgresSchema,
  verifyPostgresSchema,
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
const admissionKey: SqliteDatabaseAdmissionKey<PostgresPhysicalFacts> = {
  name: "database.engine.schema",
  schemaDependent: true,
  read(value) {
    if (
      value &&
      typeof value === "object" &&
      "engine" in value &&
      value.engine === "postgres" &&
      "admissionId" in value &&
      typeof value.admissionId === "string" &&
      "store" in value &&
      typeof value.store === "string" &&
      "namespace" in value &&
      typeof value.namespace === "string" &&
      "storeId" in value &&
      typeof value.storeId === "string" &&
      "version" in value &&
      typeof value.version === "number" &&
      "capabilities" in value &&
      value.capabilities !== null &&
      typeof value.capabilities === "object" &&
      "serverMajor" in value.capabilities &&
      typeof value.capabilities.serverMajor === "number" &&
      value.capabilities.serverMajor >= 16 &&
      "serverEncoding" in value.capabilities &&
      value.capabilities.serverEncoding === "UTF8" &&
      "clientEncoding" in value.capabilities &&
      value.capabilities.clientEncoding === "UTF8" &&
      "catalog" in value
    ) {
      return {
        engine: "postgres",
        admissionId: value.admissionId,
        store: value.store,
        namespace: value.namespace,
        storeId: value.storeId,
        version: value.version,
        capabilities: {
          serverMajor: value.capabilities.serverMajor,
          serverEncoding: "UTF8",
          clientEncoding: "UTF8",
        },
        catalog: readPostgresCatalog(value.catalog),
      };
    }
    return undefined;
  },
};

export function getPostgresPhysicalFacts(db: EngineConnection) {
  return getSqliteDatabaseAdmission(db, admissionKey);
}

/** The anchor carries PG admission facts without treating its native catalog as application data. */
export function admitPostgresPhysicalFacts(params: {
  anchor: DatabaseSync;
  db: PostgresSqlConnection;
  namespace: string;
  storeId: string;
  store: string;
  version: number;
  expected?: readonly PostgresCatalogFact[];
  schema?: StoreSchema;
  recordSchema?: boolean;
}): PostgresPhysicalFacts {
  const retained = getPostgresPhysicalFacts(params.db);
  if (retained) {
    if (
      retained.store !== params.store ||
      retained.namespace !== params.namespace ||
      retained.storeId !== params.storeId ||
      retained.version !== params.version
    ) {
      throw new Error(`PostgreSQL admission identity or version mismatch. ${recovery}`);
    }
    return retained;
  }
  assertEngineStoreExecutionAllowed();
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
    if (params.recordSchema) {
      recordPostgresSchema(params.db, params.namespace, params.schema, snapshot);
    } else {
      verifyPostgresSchema(params.db, params.namespace, params.schema, snapshot);
    }
  }
  if (params.expected) {
    assertPostgresCatalog(
      catalog.filter(
        (fact) => !fact.kind.endsWith("Definition") && fact.table !== "openclaw_schema_meta",
      ),
      params.expected,
    );
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

/** Optional native housekeeping is skipped on PostgreSQL; explicit native requests refuse below. */
export const physicalDatabaseCapabilities = {
  sqlite: {
    nativeFile: true,
    integrity: "native",
    wal: "native",
    checkpoint: "native",
    vacuum: "native",
    readSnapshot: "sqlite",
  },
  postgres: {
    nativeFile: false,
    integrity: "server-constraints",
    wal: "skip",
    checkpoint: "skip",
    vacuum: "skip",
    readSnapshot: "repeatable-read",
  },
} as const;

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
