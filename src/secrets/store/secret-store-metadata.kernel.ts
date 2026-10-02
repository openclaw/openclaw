import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import { normalizeScope, type SecretStoreScope } from "./secret-store-validation.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;
export type SecretStoreRow = Selectable<DB["secret_store_entries"]>;
export type SecretStoreListInput = {
  scope: SecretStoreScope;
  includeDeleted?: boolean;
  redactedOnly?: boolean;
};

export function listSecretStoreRows(
  sqlite: DatabaseSync,
  params: SecretStoreListInput,
): SecretStoreRow[] {
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
