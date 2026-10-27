import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-github-names.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
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
  sqlite: EngineConnection,
  input: SecretStoreReadOperations["secrets.execEnvironment"]["input"],
): SecretStoreReadOperations["secrets.execEnvironment"]["output"]["rows"] {
  const rows: SecretStoreReadOperations["secrets.execEnvironment"]["output"]["rows"] = [];
  const excluded = new Set(input.excludeNames);
  let bytes = 0;
  return withMissingSecretStoreFallback(() => {
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
  }, []);
}

function readValueRow(sqlite: EngineConnection, name: string) {
  assertSecretStoreEnvName(name);
  return withMissingSecretStoreFallback(() => {
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
  }, undefined);
}

function readSelectedSecretRows(sqlite: EngineConnection, names: readonly string[]) {
  for (const name of names) {
    assertSecretStoreEnvName(name);
  }
  if (names.length === 0) {
    return [];
  }
  return withMissingSecretStoreFallback(() => {
    // Values and destination policy come from the same statement's snapshot.
    const query = getNodeSqliteKysely<SecretStoreDatabase>(sqlite)
      .selectFrom("secret_store_entries")
      .select(["name", "value", "allowed_hosts"])
      .where("scope_kind", "=", "team")
      .where("scope_id", "=", "")
      .where("kind", "=", "secret")
      .where("deleted_at_ms", "is", null)
      .where("name", "in", [...new Set(names)])
      .orderBy("name", "asc");
    const rows: SecretStoreReadOperations["secrets.selected"]["output"]["rows"] = [];
    let bytes = 0;
    for (const row of iterateSqliteQuerySync(sqlite, query)) {
      if (Buffer.byteLength(row.value) > SECRET_STORE_VALUE_MAX_BYTES) {
        throw new Error("Secret store value exceeds its 64 KiB read limit.");
      }
      bytes +=
        32 +
        Buffer.byteLength(row.name) +
        Buffer.byteLength(row.value) +
        Buffer.byteLength(row.allowed_hosts ?? "");
      if (bytes > EXEC_ENVIRONMENT_MAX_BYTES) {
        throw new Error("Selected secret store entries exceed their 32 MiB read limit.");
      }
      rows.push(row);
    }
    return rows;
  }, []);
}

function listSecretStoreRows(
  sqlite: EngineConnection,
  params: SecretStoreListInput,
): SecretStoreRow[] {
  return withMissingSecretStoreFallback(() => {
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
  }, []);
}

export const secretStoreReadOperations = {
  "secrets.selected": (input: SecretStoreReadOperations["secrets.selected"]["input"], db) => ({
    type: "secrets.selected" as const,
    rows: readSelectedSecretRows(db, input.names),
  }),
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
} satisfies WorkerOperationHandlers<EngineConnection>;
