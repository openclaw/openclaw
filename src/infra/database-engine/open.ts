import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { databaseEngineAdapters } from "./adapters.js";
import type { DatabaseEngineInput } from "./config.js";
import type { AdmittedStore, EngineConnection, StoreSchema } from "./contract.js";
import { observeConnection } from "./observation.js";
import { admitPostgresPhysicalFacts } from "./physical-facts.js";

type EngineAdmission =
  | { engine: "sqlite" }
  | { engine: "postgres"; storeId: string; namespace: string; version: number };
const admissionKey: SqliteDatabaseAdmissionKey<EngineAdmission> = {
  name: "database.engine",
  read: (value) => {
    if (!value || typeof value !== "object" || !("engine" in value)) {
      return undefined;
    }
    if (value.engine === "sqlite") {
      return { engine: "sqlite" };
    }
    if (
      value.engine === "postgres" &&
      "storeId" in value &&
      typeof value.storeId === "string" &&
      "namespace" in value &&
      typeof value.namespace === "string" &&
      "version" in value &&
      typeof value.version === "number"
    ) {
      return {
        engine: "postgres",
        storeId: value.storeId,
        namespace: value.namespace,
        version: value.version,
      };
    }
    return undefined;
  },
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

function refusePostgresAnchor(db: DatabaseSync): void {
  const rows = readEngineAnchor(db, "schema");
  if (rows) {
    throw new Error(
      `This store lives in PostgreSQL schema ${String(rows[0]?.schema ?? "unknown")}; set database.engine to postgres and configure database.postgres.connection.`,
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
}): EngineConnection {
  const { anchor, schema } = ref;
  observeConnection(anchor);
  const postgres = ref.input !== undefined && schema.postgres !== undefined;
  const known = getSqliteDatabaseAdmission(anchor, admissionKey);
  if (!postgres) {
    if (known?.engine === "postgres") {
      throw new Error(
        `This store lives in PostgreSQL schema ${known.namespace}; set database.engine to postgres and configure database.postgres.connection.`,
      );
    }
    if (!known) {
      refusePostgresAnchor(anchor);
    }
    ref.prepareAnchor();
    databaseEngineAdapters.sqlite.schema.bootstrap({ ...ref, input: ref.input }, anchor);
    publishSqliteDatabaseAdmission(anchor, admissionKey, { engine: "sqlite" });
    return databaseEngineAdapters.sqlite.openConnection({ ...ref, input: ref.input });
  }
  if (known?.engine === "sqlite") {
    throw new Error(
      `Existing SQLite ${schema.id} data cannot switch engines; wait for the database port tool.`,
    );
  }
  ref.prepareAnchor();
  const identity =
    known?.engine === "postgres"
      ? known
      : runSqliteImmediateTransactionSync(anchor, () => {
          const inspection = ref.inspectSqlite();
          if (inspection.hasExistingData) {
            throw new Error(
              `Existing SQLite ${schema.id} data cannot switch engines; wait for the database port tool.`,
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
          return { storeId, namespace };
        });
  const store: AdmittedStore = { ...ref, input: ref.input, ...identity };
  const adapter = databaseEngineAdapters.postgres;
  const db = adapter.openConnection(store);
  try {
    if (!known) {
      // Bootstrap borrows opening custody; ordinary writes still require domain admission.
      db.runTransaction(() => {
        db.exec(`CREATE SCHEMA IF NOT EXISTS "${identity.namespace.replaceAll('"', '""')}"`);
        db.exec(
          "CREATE TABLE IF NOT EXISTS openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL)",
        );
        const meta = db
          .prepare("SELECT version, store_id FROM openclaw_schema_meta WHERE store = ?")
          .get(schema.id);
        if (!meta) {
          adapter.schema.bootstrap(store, db);
        } else {
          if (meta.store_id !== identity.storeId) {
            throw new Error(
              `PostgreSQL database identity mismatch: expected ${identity.storeId}, found ${String(meta.store_id)}. Restore the matching anchor and PostgreSQL backup.`,
            );
          }
          if (meta.version !== schema.version) {
            adapter.schema.migrate(store, Number(meta.version));
          }
        }
      });
    } else if (known.engine === "postgres" && known.version !== schema.version) {
      adapter.schema.migrate(store, known.version);
    }
    admitPostgresPhysicalFacts({
      anchor,
      db,
      namespace: identity.namespace,
      storeId: identity.storeId,
      store: schema.id,
      version: schema.version,
    });
    if (!known) {
      publishSqliteDatabaseAdmission(anchor, admissionKey, {
        engine: "postgres",
        ...identity,
        version: schema.version,
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
