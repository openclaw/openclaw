import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../sqlite-database-admission.js";
import { assertEngineStoreExecutionAllowed } from "./admission-scope.js";
import {
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "./postgres-catalog.js";

export type PostgresPhysicalFacts = {
  engine: "postgres";
  admissionId: string;
  store: string;
  namespace: string;
  storeId: string;
  version: number;
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
      "catalog" in value
    ) {
      return {
        engine: "postgres",
        admissionId: value.admissionId,
        store: value.store,
        namespace: value.namespace,
        storeId: value.storeId,
        version: value.version,
        catalog: readPostgresCatalog(value.catalog),
      };
    }
    return undefined;
  },
};

/** The anchor carries PG admission facts without treating its native catalog as application data. */
export function admitPostgresPhysicalFacts(params: {
  anchor: DatabaseSync;
  db: PostgresSqlConnection;
  namespace: string;
  storeId: string;
  store: string;
  version: number;
  expected?: readonly PostgresCatalogFact[];
}): PostgresPhysicalFacts {
  const retained = getSqliteDatabaseAdmission(params.anchor, admissionKey);
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
  const namespace = `"${params.namespace.replaceAll('"', '""')}"`;
  let result: ReturnType<PostgresSqlConnection["query"]>;
  assertEngineStoreExecutionAllowed();
  try {
    result = params.db.query(
      `WITH captured AS (${postgresCatalogQuery(params.namespace, true)})
    SELECT catalog::text, meta.version, meta.store_id FROM captured
    CROSS JOIN ${namespace}.openclaw_schema_meta meta WHERE meta.store = ?`,
      [params.store],
    );
  } catch (error) {
    throw new Error(`Cannot read PostgreSQL catalog or metadata. ${recovery}`, { cause: error });
  }
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  if (
    !row ||
    row.version !== params.version ||
    row.store_id !== params.storeId ||
    typeof row.catalog !== "string"
  ) {
    throw new Error(`PostgreSQL metadata identity or version mismatch. ${recovery}`);
  }
  const catalog = readPostgresCatalog(JSON.parse(row.catalog));
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
    catalog,
  };
  publishSqliteDatabaseAdmission(params.anchor, admissionKey, facts);
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
