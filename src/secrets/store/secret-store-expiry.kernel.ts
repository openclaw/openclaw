import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  classifyHiddenGitHubStoreName,
  GITHUB_DEVICE_STORE_MAX_AGE_MS,
  GITHUB_SETUP_HANDOFF_MAX_AGE_MS,
} from "./secret-store-github-names.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;
const SECRET_STORE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export type SecretStoreExpiryCutoffs = {
  threshold: number;
  handoffThreshold: number;
  deviceThreshold: number;
};

export function captureSecretStoreExpiryCutoffs(): SecretStoreExpiryCutoffs {
  return {
    threshold: Date.now() - SECRET_STORE_RETENTION_MS,
    handoffThreshold: Date.now() - GITHUB_SETUP_HANDOFF_MAX_AGE_MS,
    deviceThreshold: Date.now() - GITHUB_DEVICE_STORE_MAX_AGE_MS,
  };
}

export type SecretStoreExpiryResult = {
  removed: number;
  nextExpiryAtMs: number | null;
  writeToken?: string;
};

export function purgeExpiredSecretStoreEntriesInDatabase(
  cutoffs: SecretStoreExpiryCutoffs,
  databaseOptions?: OpenClawStateDatabaseOptions,
): SecretStoreExpiryResult {
  const state = openOpenClawStateDatabase(databaseOptions);
  const sqlite = state.db;
  const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
  const { threshold, handoffThreshold, deviceThreshold } = cutoffs;
  return withMissingSecretStoreFallback(
    () => {
      const readExpiry = () => {
        const deleted = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select((eb) => eb.fn.min("deleted_at_ms").as("deletedAtMs")),
        );
        const deletedAtMs = normalizeSqliteNumber(deleted?.deletedAtMs ?? null);
        let nextExpiryAtMs =
          deletedAtMs === undefined ? null : deletedAtMs + SECRET_STORE_RETENTION_MS + 1;
        const hidden = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select(["scope_kind", "scope_id", "name", "created_at_ms"])
            // Materialize only transient metadata; retained secret values stay in the database.
            .where((eb) =>
              eb.or([
                eb("name", ">=", "github-device-").and("name", "<", "github-device."),
                eb("name", ">=", "github-setup-").and("name", "<", "github-setup."),
              ]),
            )
            .where("deleted_at_ms", "is", null),
        ).rows;
        const expiredHidden = hidden.filter((row) => {
          const kind = classifyHiddenGitHubStoreName(row.name);
          const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
          if (createdAtMs === undefined || (kind !== "setup" && kind !== "device")) {
            return false;
          }
          const expiry =
            createdAtMs +
            (kind === "setup"
              ? GITHUB_SETUP_HANDOFF_MAX_AGE_MS + 1
              : GITHUB_DEVICE_STORE_MAX_AGE_MS);
          nextExpiryAtMs = Math.min(nextExpiryAtMs ?? expiry, expiry);
          return (
            (kind === "setup" && createdAtMs < handoffThreshold) ||
            (kind === "device" && createdAtMs <= deviceThreshold)
          );
        });
        return { deletedAtMs, expiredHidden, nextExpiryAtMs };
      };
      let expiry = readExpiry();
      let removed = 0;
      if (
        (expiry.deletedAtMs !== undefined && expiry.deletedAtMs < threshold) ||
        expiry.expiredHidden.length > 0
      ) {
        removed = runOpenClawStateWriteTransaction(
          () => {
            let count = 0;
            if (expiry.deletedAtMs !== undefined && expiry.deletedAtMs < threshold) {
              const deleted = executeSqliteQuerySync(
                sqlite,
                db.deleteFrom("secret_store_entries").where("deleted_at_ms", "<", threshold),
              );
              count += Number(deleted.numAffectedRows ?? 0n);
            }
            for (const row of expiry.expiredHidden) {
              const deleted = executeSqliteQuerySync(
                sqlite,
                db
                  .deleteFrom("secret_store_entries")
                  .where("scope_kind", "=", row.scope_kind)
                  .where("scope_id", "=", row.scope_id)
                  .where("name", "=", row.name)
                  // A handoff refreshed while acquiring the writer retains its new lifetime.
                  .where("created_at_ms", "=", row.created_at_ms)
                  .where("deleted_at_ms", "is", null),
              );
              count += Number(deleted.numAffectedRows ?? 0n);
            }
            return count;
          },
          { ...databaseOptions, database: state },
          { operationLabel: "secrets.store.purge" },
        );
        expiry = readExpiry();
      }
      return {
        removed,
        nextExpiryAtMs: expiry.nextExpiryAtMs,
        writeToken: readSqliteDatabaseWriteTokenForPath(state.path),
      };
    },
    { removed: 0, nextExpiryAtMs: null, writeToken: undefined },
  );
}
