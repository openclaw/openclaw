import type { DatabaseSync } from "node:sqlite";
import { redactSensitiveText } from "../../logging/redact.js";
import { getNodeSqliteKysely } from "../kysely-sync.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
} from "../sqlite-transaction.js";
import type {
  DatabaseEngineAdapter,
  DatabaseErrorKind,
  SearchSchema,
  SearchStore,
} from "./contract.js";
import { observeConnection } from "./observation.js";
import { POSTGRES_LOCK_TIMEOUT_MS, POSTGRES_STATEMENT_TIMEOUT_MS } from "./policy.js";
import {
  postgresSchemaSql,
  verifyAndRecordPostgresSchema,
  readPostgresSchema,
  verifyPostgresSchema,
} from "./postgres-schema.js";
import { bindStoreSearch } from "./search.js";
import type { DatabaseEngineInput } from "./types.js";

function classifyError(error: unknown): DatabaseErrorKind {
  if (!(error instanceof Error)) {
    return "other";
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "outcome-unknown") {
    return "outcome-unknown";
  }
  if (/connection.*lost/i.test(error.message)) {
    return "connection-lost";
  }
  if (/constraint/i.test(error.message)) {
    return "constraint";
  }
  if (/locked|busy|lock timeout/i.test(error.message)) {
    return "busy";
  }
  return "other";
}

export const databaseEngineAdapters: {
  readonly sqlite: DatabaseEngineAdapter<DatabaseSync> & { search: typeof bindStoreSearch };
  readonly postgres: DatabaseEngineAdapter<PostgresSyncConnection> & {
    search: typeof bindStoreSearch;
  };
} = {
  sqlite: {
    id: "sqlite",
    openConnection: ({ anchor }) => observeConnection(anchor),
    kysely: getNodeSqliteKysely,
    transactions: {
      write: runSqliteImmediateTransactionSync,
      read: runSqliteDeferredTransactionSync,
    },
    capabilities: { fullText: "fts5", vector: "sqlite-vec" },
    search: bindStoreSearch,
    schema: {
      // The store's existing SQLite schema/migration owner runs unchanged at open.
      bootstrap: (store) => store.openSqlite(),
      migrate: (store) => store.openSqlite(),
    },
    classifyError,
  },
  postgres: {
    id: "postgres",
    openConnection: (store) => {
      if (!store.input || !store.storeId || !store.namespace) {
        throw new Error("PostgreSQL store is not admitted");
      }
      try {
        return new PostgresSyncConnection(
          store.input.connection,
          store.namespace,
          store.anchor,
          store.storeId,
          {
            lockTimeoutMs: POSTGRES_LOCK_TIMEOUT_MS,
            statementTimeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS,
          },
        );
      } catch (error) {
        const code =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? `${error.code}: `
            : "";
        const reason = redactSensitiveText(
          `${code}${error instanceof Error ? error.message : String(error)}`.replaceAll(
            store.input.connection,
            "[REDACTED]",
          ),
          { mode: "tools" },
        );
        throw new Error(
          `Cannot open PostgreSQL connection: ${reason}; verify database.postgres.connection and server availability.`,
          { cause: error },
        );
      }
    },
    kysely: getNodeSqliteKysely,
    transactions: { write: runSqliteImmediateTransactionSync, read: runSqliteReadSnapshotSync },
    capabilities: { fullText: "tsvector", vector: null },
    search: bindStoreSearch,
    schema: {
      bootstrap: (store, db) => {
        if (!store.schema.postgres) {
          throw new Error("Store has no PostgreSQL schema");
        }
        db.exec(postgresSchemaSql(store.schema, store.namespace!));
        db.prepare(
          "INSERT INTO openclaw_schema_meta (store, version, store_id) VALUES (?, ?, ?)",
        ).run(store.schema.id, store.schema.version, store.storeId!);
      },
      migrate: (store, from, db) => {
        if (from > store.schema.version) {
          throw new Error(
            `PostgreSQL ${store.schema.id} schema ${from} is newer than this build (expected ${store.schema.version}); use a compatible binary, or reverse-port with a compatible binary before downgrading.`,
          );
        }
        for (let version = from + 1; version <= store.schema.version; version++) {
          const migration = store.schema.postgresMigrations?.find(
            (step) => step.version === version,
          );
          if (!migration) {
            throw new Error(
              `Missing PostgreSQL ${store.schema.id} migration to version ${version}; use a compatible binary or restore a matching backup.`,
            );
          }
          verifyPostgresSchema(
            db,
            store.namespace!,
            {
              ...store.schema,
              version: version - 1,
              postgres: migration.fromSchema.postgres,
              postgresFragments: migration.fromSchema.postgresFragments,
            },
            readPostgresSchema(db, store.namespace!, store.schema.id),
          );
          db.exec(migration.sql);
          db.prepare("UPDATE openclaw_schema_meta SET version = ? WHERE store = ?").run(
            version,
            store.schema.id,
          );
          verifyAndRecordPostgresSchema(db, store.namespace!, {
            ...store.schema,
            version,
            postgres: migration.schema.postgres,
            postgresFragments: migration.schema.postgresFragments,
          });
        }
      },
    },
    classifyError,
  },
};

/** @experimental Select the admitted engine once and bind its declared search indexes. */
export function admitStoreSearch(store: SearchStore, schema: SearchSchema) {
  const postgres =
    "databasePath" in store ? store.input !== undefined : isPostgresSqlConnection(store);
  return databaseEngineAdapters[postgres ? "postgres" : "sqlite"].search(store, schema);
}

/** Worker envelopes need a transaction only on PostgreSQL; native SQLite statements stay identical. */
export function runEngineWorkerWrite<T>(
  input: DatabaseEngineInput,
  operation: () => T,
  transaction: (operation: () => T) => T,
): T {
  return input ? transaction(operation) : operation();
}

export function runEngineStoreReadSnapshot<T>(
  db: Parameters<typeof getNodeSqliteKysely>[0] | PostgresSyncConnection,
  operation: () => T,
): T {
  return isPostgresSqlConnection(db)
    ? runSqliteReadSnapshotSync(db, operation)
    : runSqliteDeferredTransactionSync(db, operation);
}

/** Dedicated streaming readers retain this snapshot until their last host acknowledgement. */
export function beginEngineStoreReadSnapshot(db: DatabaseSync | PostgresSqlConnection): {
  close: () => void;
} {
  if (db.isTransaction) {
    throw new Error("Streaming read snapshot requires a dedicated connection");
  }
  // sqlite-allow-raw: The engine owns the explicit snapshot lifetime across asynchronous host ACKs.
  db.exec(
    isPostgresSqlConnection(db)
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN DEFERRED",
  );
  return {
    close() {
      if (db.isTransaction) {
        // sqlite-allow-raw: A read snapshot never publishes writes.
        db.exec("ROLLBACK");
      }
    },
  };
}
