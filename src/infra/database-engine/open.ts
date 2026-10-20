import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  invalidateLocalSqliteSchemaAdmissions,
  publishSqliteDatabaseAdmission,
  publishSqliteDatabaseSchemaChange,
  type SqliteDatabaseFactKey,
} from "../sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { beginUpdatePostgresMigration } from "../update-doctor-migration-attribution.js";
import { databaseEngineAdapters } from "./adapters.js";
import type { AdmittedStore, EngineConnection, StoreSchema } from "./contract.js";
import { observeConnection } from "./observation.js";
import { admitPostgresPhysicalFacts } from "./physical-facts.js";
import {
  admitPostgresCapabilities,
  postgresSchemaMetadataSql,
  getAdmittedPostgresSchema,
} from "./postgres-schema.js";
import { admitPostgresSearch } from "./postgres-search-schema.js";
import type { DatabaseEngineInput } from "./types.js";

type EngineAdmission =
  | { engine: "sqlite" }
  | { engine: "postgres"; storeId: string; namespace: string; version: number };
const admissionKey: SqliteDatabaseFactKey<EngineAdmission> = {
  name: "database.engine",
};

export function readEngineAnchor(
  db: DatabaseSync,
  projection: "schema" | "identity" = "identity",
  requireTable = false,
) {
  try {
    return projection === "schema"
      ? [db.prepare("SELECT schema FROM openclaw_engine_anchor LIMIT 1").get()]
      : db.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all();
  } catch (error) {
    if (
      requireTable ||
      !(error instanceof Error) ||
      error.message !== "no such table: openclaw_engine_anchor"
    ) {
      throw error;
    }
    return undefined;
  }
}

function familySetting(schema: StoreSchema): string {
  return `database.families.${schema.id === "team_reports" ? "team-reports" : schema.id}.engine`;
}

function refusePostgresAnchor(db: DatabaseSync, schema: StoreSchema): void {
  const rows = readEngineAnchor(db, "schema");
  if (rows) {
    throw new Error(
      `This store lives in PostgreSQL schema ${String(rows[0]?.schema ?? "unknown")}; set ${familySetting(schema)} to postgres and configure database.postgres.connection.`,
    );
  }
}

/** Reuses the physical SQLite admission exchange across worker handles and idle reopen. */
export function openEngineStore(ref: {
  anchor: DatabaseSync;
  schema: StoreSchema;
  input?: DatabaseEngineInput;
  openSqlite: () => void;
  prepareAnchor: () => void;
  inspectSqlite: () => { hasExistingData: boolean; hasEngineAnchor: boolean };
  existingOnly?: boolean;
  /** Existing-state short leases may retain an idle PG transport in this worker. */
  reusePostgresConnection?: boolean;
  /** Inspection admits the declared source schema without running its migration. */
  existingVersion?: boolean;
  /** Bind owner-local state inside the new anchor transaction before connecting. */
  onFreshAnchor?: (anchor: DatabaseSync) => void;
  admitPostgres?: (db: PostgresSqlConnection, fresh: boolean) => void;
  beforeMigrate?: (db: EngineConnection, fromVersion: number) => void;
  /** Family custody for schema writes; shared state defaults to its physical owner. */
  assertMigrationCurrent?: () => void;
  closeOnFailure?: (db: PostgresSqlConnection, error: unknown) => never;
}): EngineConnection {
  const { anchor } = ref;
  let schema = ref.schema;
  observeConnection(anchor);
  const postgres = ref.input !== undefined && schema.postgres !== undefined;
  const known = getSqliteDatabaseAdmission(anchor, admissionKey);
  if (!postgres) {
    if (known?.engine === "postgres") {
      throw new Error(
        `This store lives in PostgreSQL schema ${known.namespace}; set ${familySetting(schema)} to postgres and configure database.postgres.connection.`,
      );
    }
    if (!known && ref.inspectSqlite().hasEngineAnchor) {
      refusePostgresAnchor(anchor, schema);
    }
    ref.prepareAnchor();
    databaseEngineAdapters.sqlite.schema.bootstrap({ ...ref, input: ref.input }, anchor);
    publishSqliteDatabaseAdmission(anchor, admissionKey, { engine: "sqlite" });
    return databaseEngineAdapters.sqlite.openConnection({ ...ref, input: ref.input });
  }
  if (known?.engine === "sqlite") {
    throw new Error(
      `Existing SQLite ${schema.id} data cannot switch engines; stop the Gateway and use openclaw database port for a supported store family before changing ${familySetting(schema)}.`,
    );
  }
  ref.prepareAnchor();
  const readOrCreateAnchor = () => {
    const inspection = ref.inspectSqlite();
    if (inspection.hasExistingData) {
      throw new Error(
        `Existing SQLite ${schema.id} data cannot switch engines; stop the Gateway and use openclaw database port for a supported store family before changing ${familySetting(schema)}.`,
      );
    }
    if (!inspection.hasEngineAnchor && ref.existingOnly) {
      throw new Error(
        "Missing PostgreSQL anchor; restore the matching PostgreSQL schema and anchor.",
      );
    }
    if (!inspection.hasEngineAnchor) {
      anchor.exec(
        "CREATE TABLE IF NOT EXISTS openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
      );
    }
    const rows = readEngineAnchor(anchor, "identity", true) ?? [];
    if (rows.length > 1 || (inspection.hasEngineAnchor && rows.length === 0)) {
      throw new Error(
        "Invalid engine anchor: expected exactly one identity. Restore a matching backup.",
      );
    }
    const row = rows[0];
    if (row) {
      if (
        typeof row.store_id !== "string" ||
        row.engine !== "postgres" ||
        typeof row.schema !== "string"
      ) {
        throw new Error("Invalid PostgreSQL anchor identity. Restore a matching backup.");
      }
      return { storeId: row.store_id, namespace: row.schema };
    }
    const storeId = randomUUID();
    const namespace = `${ref.input!.schemaPrefix}_${schema.id}_${storeId.replaceAll("-", "").slice(0, 16)}`;
    anchor
      .prepare(
        "INSERT INTO openclaw_engine_anchor (store_id, engine, schema) VALUES (?, 'postgres', ?)",
      )
      .run(storeId, namespace);
    ref.onFreshAnchor?.(anchor);
    return { storeId, namespace };
  };
  const identity =
    known?.engine === "postgres"
      ? known
      : ref.existingOnly
        ? readOrCreateAnchor()
        : runSqliteImmediateTransactionSync(anchor, readOrCreateAnchor);
  const store: AdmittedStore = { ...ref, input: ref.input, ...identity };
  const adapter = databaseEngineAdapters.postgres;
  const db = adapter.openConnection(store);
  const admit = (fresh: boolean) => {
    admitPostgresPhysicalFacts({
      db,
      namespace: identity.namespace,
      storeId: identity.storeId,
      store: schema.id,
      version: schema.version,
      schema,
      recordSchema: fresh,
      preserveSchemaSeal: ref.existingVersion,
    });
    ref.admitPostgres?.(db, fresh);
  };
  try {
    const publishSearch = schema.search
      ? admitPostgresSearch(db, schema.search, identity.namespace)
      : undefined;
    if (!known || (known.engine === "postgres" && known.version !== schema.version)) {
      admitPostgresCapabilities(db);
      // Bootstrap borrows opening custody; ordinary writes still require domain admission.
      // Existing-only forbids creation; an unsealed port still needs writable schema admission.
      let migration: ReturnType<typeof beginUpdatePostgresMigration>;
      let assertMigrationCurrent: (() => void) | undefined;
      db.runTransaction(
        () => {
          const fresh = !db
            .prepare("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ?")
            .get(identity.namespace);
          if (fresh && !ref.existingOnly) {
            db.exec(`CREATE SCHEMA IF NOT EXISTS "${identity.namespace.replaceAll('"', '""')}"`);
            db.exec(postgresSchemaMetadataSql);
          }
          let meta;
          try {
            meta = db
              .prepare("SELECT version, store_id FROM openclaw_schema_meta WHERE store = ?")
              .get(schema.id);
          } catch (cause) {
            throw new Error(
              "Missing PostgreSQL metadata; use the matching OpenClaw version or restore the matching PostgreSQL schema and anchor.",
              { cause },
            );
          }
          if (!meta) {
            if (ref.existingOnly || !fresh) {
              throw new Error(
                "Missing PostgreSQL metadata; restore the matching PostgreSQL schema and anchor.",
              );
            }
            adapter.schema.bootstrap(store, db);
          } else {
            if (meta.store_id !== identity.storeId) {
              throw new Error(
                `PostgreSQL database identity mismatch: expected ${identity.storeId}, found ${String(meta.store_id)}. Restore the matching anchor and PostgreSQL backup.`,
              );
            }
            if (meta.version !== schema.version) {
              if (ref.existingVersion) {
                const source = schema.postgresMigrations?.find(
                  (step) => step.version === Number(meta.version) + 1,
                )?.fromSchema;
                if (!source) {
                  throw new Error("Missing PostgreSQL source schema for inspection");
                }
                schema = { ...schema, ...source, version: Number(meta.version) };
              } else {
                assertMigrationCurrent = ref.assertMigrationCurrent;
                assertMigrationCurrent?.();
                migration = beginUpdatePostgresMigration(db, assertMigrationCurrent);
                invalidateLocalSqliteSchemaAdmissions(db);
                stageSqliteTransactionState(db, {
                  stage: () => {},
                  rollback: () => {},
                  commit: () => publishSqliteDatabaseSchemaChange(db),
                  invalidate: () => publishSqliteDatabaseSchemaChange(db),
                });
                const migrate = () => adapter.schema.migrate(store, Number(meta.version), db);
                if (migration) {
                  migration.run(migrate);
                } else {
                  migrate();
                }
              }
            }
          }
          admit(!meta);
        },
        {
          withCommit(commit) {
            assertMigrationCurrent?.();
            migration?.beforeCommit();
            commit();
          },
        },
        false,
      );
      migration?.committed();
    } else {
      admit(false);
    }
    if (!known || (known.engine === "postgres" && known.version !== schema.version)) {
      publishSqliteDatabaseAdmission(anchor, admissionKey, {
        engine: "postgres",
        ...identity,
        version: schema.version,
      });
    }
    // Publish against the committed schema revision, after bootstrap/migration settles.
    publishSearch?.();
    for (const extension of Object.values(getAdmittedPostgresSchema(db)?.searchExtensions ?? {})) {
      admitPostgresSearch(db, extension, identity.namespace)?.();
    }
    return db;
  } catch (error) {
    if (ref.closeOnFailure) {
      return ref.closeOnFailure(db, error);
    }
    db.close();
    throw error;
  }
}
