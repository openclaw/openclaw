import { createHash, randomUUID } from "node:crypto";
import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseFactKey,
} from "../sqlite-database-admission.js";
import type { StoreSchema } from "./contract.js";
import type { PostgresCapabilities } from "./physical-facts-contract.js";
import {
  postgresCatalogQuery,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "./postgres-catalog.js";
import { postgresSearchSql } from "./postgres-search-schema.js";

export type { PostgresCapabilities } from "./physical-facts-contract.js";

export function postgresStoreNamespace(
  schemaPrefix: string,
  store: string,
  storeId: string,
): string {
  return `${schemaPrefix}_${store}_${storeId.replaceAll("-", "").slice(0, 16)}`;
}

export const postgresSchemaMetadataSql = `CREATE TABLE openclaw_schema_meta (
  store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL,
  fingerprint TEXT, ddl_hash TEXT, server_major BIGINT)`;
const recovery =
  "Use a compatible OpenClaw binary or restore the matching PostgreSQL schema and anchor; do not edit schema metadata.";
// Keep the DDL seal portable when a backup is restored into a fresh namespace.
const canonicalNamespace = "openclaw_schema";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const capabilities = new WeakMap<PostgresSqlConnection, PostgresCapabilities>();
// Definitions follow physical admission across handles and worker isolates.
const admittedSchemaKey: SqliteDatabaseFactKey<StoreSchema> = {
  name: "database.postgres.schema",
  schemaDependent: true,
};
export const getAdmittedPostgresSchema = (db: PostgresSqlConnection) =>
  getSqliteDatabaseAdmission(db, admittedSchemaKey);
export const retainPostgresSchema = (db: PostgresSqlConnection, schema: StoreSchema) => {
  // Upgrade recipes can contain backup callbacks; workers only need the current definition.
  const { postgresMigrations: _migrations, ...definition } = schema;
  publishSqliteDatabaseAdmission(db, admittedSchemaKey, definition);
};

export function admitPostgresCapabilities(db: PostgresSqlConnection): PostgresCapabilities {
  const retained = capabilities.get(db);
  if (retained) {
    return retained;
  }
  const row = db
    .prepare(
      "SELECT current_setting('server_version_num')::int AS version, current_setting('server_encoding') AS server_encoding, current_setting('client_encoding') AS client_encoding",
    )
    .get();
  if (
    !row ||
    typeof row.version !== "number" ||
    row.version < 160000 ||
    row.server_encoding !== "UTF8" ||
    row.client_encoding !== "UTF8"
  ) {
    throw new Error(
      "PostgreSQL requires version 16 or newer and UTF8 server/client encoding; upgrade the server or port to a UTF8 database and set client_encoding=UTF8.",
    );
  }
  const facts: PostgresCapabilities = {
    serverMajor: Math.floor(row.version / 10000),
    serverEncoding: "UTF8",
    clientEncoding: "UTF8",
  };
  capabilities.set(db, facts);
  return facts;
}

export function readPostgresSchema(db: PostgresSqlConnection, namespace: string, store: string) {
  const row = db.query(
    `WITH captured AS (${postgresCatalogQuery(namespace, true)})
    SELECT catalog::text, to_jsonb(meta)::text AS metadata FROM captured
    CROSS JOIN ${quote(namespace)}.openclaw_schema_meta meta WHERE meta.store = ?`,
    [store],
  ).rows[0];
  if (!row || typeof row.catalog !== "string" || typeof row.metadata !== "string") {
    throw new Error(`Missing PostgreSQL catalog or metadata. ${recovery}`);
  }
  const metadata: {
    version: number;
    store_id: string;
    fingerprint?: string;
    ddl_hash?: string;
    server_major?: number;
    search_extensions?: string;
  } = JSON.parse(row.metadata);
  return { catalog: readPostgresCatalog(JSON.parse(row.catalog)), metadata };
}

export function withPostgresSearchExtensions(
  schema: StoreSchema,
  snapshot: ReturnType<typeof readPostgresSchema>,
): StoreSchema {
  return { ...schema, searchExtensions: JSON.parse(snapshot.metadata.search_extensions ?? "{}") };
}

function postgresSchemaFingerprint(
  catalog: readonly PostgresCatalogFact[],
  scratch?: { from: string; to: string },
): string {
  const text = catalog
    .filter((fact) => fact.table !== "openclaw_schema_meta")
    .map((fact) => JSON.stringify(fact))
    .toSorted()
    .join("\n");
  if (!scratch) {
    return hash(text);
  }
  // PostgreSQL quotes hyphenated namespaces such as team-reports, unlike the scratch name.
  const from = JSON.stringify(scratch.from).slice(1, -1);
  const quotedFrom = JSON.stringify(quote(scratch.from)).slice(1, -1);
  const to = JSON.stringify(scratch.to).slice(1, -1);
  return hash(text.replaceAll(`${quotedFrom}.`, `${from}.`).replaceAll(from, to));
}

export function postgresSchemaSql(
  schema: StoreSchema,
  namespace: string,
  catalog?: readonly PostgresCatalogFact[],
): string {
  const tables = new Set(
    catalog?.filter((fact) => fact.kind === "table").map((fact) => fact.table),
  );
  const active =
    schema.postgresFragments?.filter((fragment) =>
      catalog
        ? fragment.tables.some((table) => tables.has(table))
        : fragment.activation === "version-additive",
    ) ?? [];
  const ordered = new Map<string, string>();
  const add = (fragment: (typeof active)[number]) => {
    if (ordered.has(fragment.id)) {
      return;
    }
    for (const id of fragment.dependencies) {
      const dependency = schema.postgresFragments?.find((item) => item.id === id);
      if (!dependency) {
        throw new Error(`Missing PostgreSQL fragment dependency ${id}`);
      }
      add(dependency);
    }
    ordered.set(fragment.id, fragment.sql);
  };
  active.forEach(add);
  const search = [schema.search, ...Object.values(schema.searchExtensions ?? {})].filter(
    (item) => item !== undefined,
  );
  const shared = { text: false, vector: false };
  const searchSql = search.map((definition) => {
    const ddl = postgresSearchSql(
      definition,
      namespace,
      shared,
      schema.postgresVectorDecoderVersion,
      schema.postgresVectorSearchVersion,
      schema.postgresTextSearchVersion,
    );
    shared.text ||= Object.keys(definition.text ?? {}).length > 0;
    shared.vector ||=
      definition.mode !== "keyword-only" && Object.keys(definition.vector ?? {}).length > 0;
    return `;\n${ddl}`;
  });
  return [schema.postgres ?? "", ...ordered.values(), ...searchSql].join("\n");
}

export function recordPostgresSchema(
  db: PostgresSqlConnection,
  namespace: string,
  schema: StoreSchema,
  snapshot?: ReturnType<typeof readPostgresSchema>,
) {
  if (!db.isTransaction) {
    throw new Error("PostgreSQL schema publication requires the owner's writer transaction");
  }
  const captured = snapshot ?? readPostgresSchema(db, namespace, schema.id);
  db.prepare(
    "UPDATE openclaw_schema_meta SET fingerprint = ?, ddl_hash = ?, server_major = ? WHERE store = ?",
  ).run(
    postgresSchemaFingerprint(captured.catalog),
    hash(postgresSchemaSql(schema, canonicalNamespace, captured.catalog)),
    admitPostgresCapabilities(db).serverMajor,
    schema.id,
  );
}

/** Rare upgrade/unsealed-pilot path: PostgreSQL deparses both sides on this server. */
export function verifyPostgresSchema(
  db: PostgresSqlConnection,
  namespace: string,
  schema: StoreSchema,
  snapshot: ReturnType<typeof readPostgresSchema>,
  preserveSeal = false,
): void {
  const fingerprint = postgresSchemaFingerprint(snapshot.catalog);
  const ddl = postgresSchemaSql(schema, canonicalNamespace, snapshot.catalog);
  const { metadata } = snapshot;
  const major = admitPostgresCapabilities(db).serverMajor;
  if (
    metadata.server_major === major &&
    metadata.fingerprint &&
    metadata.fingerprint !== fingerprint
  ) {
    throw new Error(`PostgreSQL schema drift detected. ${recovery}`);
  }
  if (metadata.server_major === major && metadata.fingerprint && metadata.ddl_hash === hash(ddl)) {
    return;
  }
  // Inspection may compare reconstructed source DDL without rewriting the installed seal.
  if (preserveSeal) {
    db.runTransaction(() => verifyPostgresSchemaDefinition(db, namespace, schema, snapshot));
  } else {
    // Fragment regrouping can change DDL bytes without changing the canonical catalog.
    verifyAndRecordPostgresSchema(db, namespace, schema, snapshot);
  }
}

function verifyPostgresSchemaDefinition(
  db: PostgresSqlConnection,
  namespace: string,
  schema: StoreSchema,
  snapshot: ReturnType<typeof readPostgresSchema>,
): void {
  const fingerprint = postgresSchemaFingerprint(snapshot.catalog, {
    from: namespace,
    to: namespace,
  });
  const scratch = `openclaw_check_${randomUUID().replaceAll("-", "")}`;
  db.exec(`CREATE SCHEMA ${quote(scratch)}`);
  try {
    db.exec(`SET LOCAL search_path TO ${quote(scratch)}`);
    db.exec(postgresSchemaSql(schema, scratch, snapshot.catalog));
    const row = db.query(
      `SELECT catalog::text FROM (${postgresCatalogQuery(scratch, true)}) captured`,
    ).rows[0];
    const expected = readPostgresCatalog(JSON.parse(String(row?.catalog)));
    if (postgresSchemaFingerprint(expected, { from: scratch, to: namespace }) !== fingerprint) {
      throw new Error(`PostgreSQL schema drift detected against generated DDL. ${recovery}`);
    }
  } finally {
    db.exec(`SET LOCAL search_path TO ${quote(namespace)}`);
    db.exec(`DROP SCHEMA ${quote(scratch)} CASCADE`);
  }
}

/** Migrations and major upgrades validate the destination before publishing its seal. */
export function verifyAndRecordPostgresSchema(
  db: PostgresSqlConnection,
  namespace: string,
  schema: StoreSchema,
  snapshot = readPostgresSchema(db, namespace, schema.id),
): ReturnType<typeof readPostgresSchema> {
  db.runTransaction(() => {
    verifyPostgresSchemaDefinition(db, namespace, schema, snapshot);
    if (!snapshot.metadata.ddl_hash) {
      db.exec(
        "ALTER TABLE openclaw_schema_meta ADD COLUMN IF NOT EXISTS fingerprint TEXT, ADD COLUMN IF NOT EXISTS ddl_hash TEXT, ADD COLUMN IF NOT EXISTS server_major BIGINT",
      );
    }
    recordPostgresSchema(db, namespace, schema, snapshot);
  });
  return snapshot;
}
