import type { DatabaseSync } from "node:sqlite";
import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import { normalizeScope } from "./secret-store-validation.js";
import type { SecretStoreListInput, SecretStoreRow } from "./secret-store.types.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;

function listSecretStoreRows(sqlite: DatabaseSync, params: SecretStoreListInput): SecretStoreRow[] {
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  try {
    const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
    let query = db
      .selectFrom("secret_store_entries")
      .selectAll()
      .where("scope_kind", "=", scopeKind)
      .where("scope_id", "=", scopeId)
      .orderBy("name", "asc");
    if (!params.includeDeleted) {
      query = query.where("deleted_at_ms", "is", null);
    }
    return executeSqliteQuerySync(sqlite, query).rows.filter(
      (row) =>
        classifyHiddenGitHubStoreName(row.name) === undefined &&
        (!params.redactedOnly || isRedactedSecretValue(row.value)),
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

export const secretStoreReadOperations = {
  "secrets.metadata": (input: SecretStoreListInput, db) => ({
    type: "secrets.metadata" as const,
    rows: listSecretStoreRows(db, input),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
