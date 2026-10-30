import type { DatabaseSync } from "node:sqlite";
import { redactSensitiveText } from "../../logging/redact.js";
import { getNodeSqliteKysely } from "../kysely-sync.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteReadSnapshotSync,
} from "../sqlite-transaction.js";
import type { DatabaseEngineAdapter } from "./contract.js";
import { observeConnection } from "./observation.js";
import { POSTGRES_LOCK_TIMEOUT_MS, POSTGRES_STATEMENT_TIMEOUT_MS } from "./policy.js";
import {
  postgresSchemaSql,
  verifyAndRecordPostgresSchema,
  readPostgresSchema,
  verifyPostgresSchema,
  withPostgresSearchExtensions,
} from "./postgres-schema.js";
import { admitPostgresSearch } from "./postgres-search-schema.js";
import type { DatabaseEngineInput } from "./types.js";

export { admitStoreSearch } from "./search-admission.js";

export const databaseEngineAdapters: {
  readonly sqlite: Pick<DatabaseEngineAdapter<DatabaseSync>, "openConnection"> & {
    schema: Pick<DatabaseEngineAdapter<DatabaseSync>["schema"], "bootstrap">;
  };
  readonly postgres: Pick<
    DatabaseEngineAdapter<PostgresSyncConnection>,
    "openConnection" | "schema"
  >;
} = {
  sqlite: {
    openConnection: ({ anchor }) => observeConnection(anchor),
    schema: {
      // The store's existing SQLite schema/migration owner runs unchanged at open.
      bootstrap: (store) => store.openSqlite(),
    },
  },
  postgres: {
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
            reuse: store.reusePostgresConnection,
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
          const snapshot = readPostgresSchema(db, store.namespace!, store.schema.id);
          const schema = withPostgresSearchExtensions(store.schema, snapshot);
          verifyPostgresSchema(
            db,
            store.namespace!,
            {
              ...schema,
              version: version - 1,
              postgres: migration.fromSchema.postgres,
              postgresFragments: migration.fromSchema.postgresFragments,
              postgresVectorDecoderVersion: migration.fromSchema.postgresVectorDecoderVersion,
              postgresVectorSearchVersion: migration.fromSchema.postgresVectorSearchVersion,
              postgresTextSearchVersion: migration.fromSchema.postgresTextSearchVersion,
            },
            snapshot,
          );
          if (
            migration.schema.postgresVectorSearchVersion === 2 &&
            migration.fromSchema.postgresVectorSearchVersion !== 2
          ) {
            for (const definition of [
              schema.search,
              ...Object.values(schema.searchExtensions ?? {}),
            ]) {
              if (definition) {
                admitPostgresSearch(db, definition, store.namespace!, 2);
              }
            }
          }
          store.beforeMigrate?.(
            db,
            version - 1,
            new Set(
              snapshot.catalog.filter((fact) => fact.kind === "table").map((fact) => fact.table),
            ),
          );
          db.exec(migration.sql);
          db.prepare("UPDATE openclaw_schema_meta SET version = ? WHERE store = ?").run(
            version,
            store.schema.id,
          );
          verifyAndRecordPostgresSchema(db, store.namespace!, {
            ...schema,
            version,
            postgres: migration.schema.postgres,
            postgresFragments: migration.schema.postgresFragments,
            postgresVectorDecoderVersion: migration.schema.postgresVectorDecoderVersion,
            postgresVectorSearchVersion: migration.schema.postgresVectorSearchVersion,
            postgresTextSearchVersion: migration.schema.postgresTextSearchVersion,
          });
        }
      },
    },
  },
};

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
