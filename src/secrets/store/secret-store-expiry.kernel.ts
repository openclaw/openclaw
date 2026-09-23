import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
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
} from "./secret-store-hidden-github.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";

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

export function purgeExpiredSecretStoreEntriesInDatabase(
  cutoffs: SecretStoreExpiryCutoffs,
  databaseOptions?: OpenClawStateDatabaseOptions,
): number {
  const state = openOpenClawStateDatabase(databaseOptions);
  const { threshold, handoffThreshold, deviceThreshold } = cutoffs;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const deleted = executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("secret_store_entries")
            .where("deleted_at_ms", "is not", null)
            .where("deleted_at_ms", "<", threshold),
        );
        const hiddenRows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select(["scope_kind", "scope_id", "name", "created_at_ms"])
            // Materialize only transient prefixes; the classifier below still owns exact names.
            .where((eb) =>
              eb.or([
                eb("name", ">=", "github-device-").and("name", "<", "github-device."),
                eb("name", ">=", "github-setup-").and("name", "<", "github-setup."),
              ]),
            )
            .where("deleted_at_ms", "is", null)
            .where("created_at_ms", "<=", Math.max(handoffThreshold, deviceThreshold)),
        ).rows.filter((row) => {
          const kind = classifyHiddenGitHubStoreName(row.name);
          const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
          return (
            createdAtMs !== undefined &&
            ((kind === "setup" && createdAtMs < handoffThreshold) ||
              (kind === "device" && createdAtMs <= deviceThreshold))
          );
        });
        let expiredHidden = 0;
        for (const row of hiddenRows) {
          const result = executeSqliteQuerySync(
            sqlite,
            db
              .deleteFrom("secret_store_entries")
              .where("scope_kind", "=", row.scope_kind)
              .where("scope_id", "=", row.scope_id)
              .where("name", "=", row.name),
          );
          expiredHidden += Number(result.numAffectedRows ?? 0n);
        }
        return Number(deleted.numAffectedRows ?? 0n) + expiredHidden;
      },
      { ...databaseOptions, database: state },
      { operationLabel: "secrets.store.purge" },
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return 0;
    }
    throw error;
  }
}
