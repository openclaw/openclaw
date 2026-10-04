import type { DatabaseSync } from "node:sqlite";
import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import { SECRET_STORE_VALUE_MAX_BYTES } from "./secret-store-validation-error.js";
import { assertSecretStoreEnvName } from "./secret-store-validation.js";
import type {
  SecretStoreListInput,
  SecretStoreReadOperations,
  SecretStoreRow,
} from "./secret-store.types.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;

// Bound the existing read reply in memory, using the SecretRef batch's 32 MiB budget.
const EXEC_ENVIRONMENT_MAX_BYTES = 512 * SECRET_STORE_VALUE_MAX_BYTES;

function readExecEnvironmentRows(
  sqlite: DatabaseSync,
  input: SecretStoreReadOperations["secrets.execEnvironment"]["input"],
): SecretStoreReadOperations["secrets.execEnvironment"]["output"]["rows"] {
  const rows: SecretStoreReadOperations["secrets.execEnvironment"]["output"]["rows"] = [];
  const excluded = new Set(input.excludeNames);
  let bytes = 0;
  try {
    const query = getNodeSqliteKysely<SecretStoreDatabase>(sqlite)
      .selectFrom("secret_store_entries")
      .select(["name", "value", "kind", "allowed_hosts"])
      .where("scope_kind", "=", "team")
      .where("scope_id", "=", "")
      .where("deleted_at_ms", "is", null)
      .orderBy("name", "asc");
    for (const row of iterateSqliteQuerySync(sqlite, query)) {
      if (classifyHiddenGitHubStoreName(row.name) !== undefined || excluded.has(row.name)) {
        continue;
      }
      bytes +=
        32 +
        Buffer.byteLength(row.name) +
        Buffer.byteLength(row.value) +
        Buffer.byteLength(row.kind) +
        Buffer.byteLength(row.allowed_hosts ?? "");
      if (bytes > EXEC_ENVIRONMENT_MAX_BYTES) {
        throw new Error(
          "Secret store exec environment exceeds its 32 MiB read limit. Reduce the stored exec environment before retrying.",
        );
      }
      rows.push(row);
    }
    return rows;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

function readValueRow(sqlite: DatabaseSync, name: string) {
  assertSecretStoreEnvName(name);
  try {
    const row = executeSqliteQueryTakeFirstSync(
      sqlite,
      getNodeSqliteKysely<SecretStoreDatabase>(sqlite)
        .selectFrom("secret_store_entries")
        .select(["value", "kind"])
        .where("scope_kind", "=", "team")
        .where("scope_id", "=", "")
        .where("name", "=", name)
        .where("deleted_at_ms", "is", null),
    );
    if (row && Buffer.byteLength(row.value) > SECRET_STORE_VALUE_MAX_BYTES) {
      throw new Error("Secret store value exceeds its 64 KiB read limit.");
    }
    return row;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

function listSecretStoreRows(sqlite: DatabaseSync, params: SecretStoreListInput): SecretStoreRow[] {
  try {
    const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
    let query = db
      .selectFrom("secret_store_entries")
      .selectAll()
      .where("scope_kind", "=", "team")
      .where("scope_id", "=", "")
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
  "secrets.execEnvironment": (
    input: SecretStoreReadOperations["secrets.execEnvironment"]["input"],
    db,
  ) => ({
    type: "secrets.execEnvironment" as const,
    rows: readExecEnvironmentRows(db, input),
  }),
  "secrets.value": (input: SecretStoreReadOperations["secrets.value"]["input"], db) => ({
    type: "secrets.value" as const,
    row: readValueRow(db, input.name),
  }),
  "secrets.metadata": (input: SecretStoreListInput, db) => ({
    type: "secrets.metadata" as const,
    rows: listSecretStoreRows(db, input),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
