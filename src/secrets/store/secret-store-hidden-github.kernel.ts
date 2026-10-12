import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  assertHiddenGitHubSecretRecordName,
  classifyHiddenGitHubStoreName,
  GITHUB_DEVICE_STORE_MAX_AGE_MS,
  hiddenGitHubStoreKindFromPrefix,
  type HiddenGitHubStorePrefix,
} from "./secret-store-github-names.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
import { SecretStoreValidationError } from "./secret-store-validation-error.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";
type HiddenGitHubStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;
type HiddenGitHubStoreRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;
export class PersonalGitHubStateError extends Error {
  constructor() {
    super("Personal GitHub state is invalid; disconnect and reconnect My GitHub.");
  }
}

/** Private GitHub aggregate only; identity secrets have no generic reader or projection. */
export function readPersonalGitHubSecret(db: DatabaseSync, profileId: string): string | undefined {
  return withMissingSecretStoreFallback(() => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<HiddenGitHubStoreDatabase>(db)
        .selectFrom("secret_store_entries")
        .select(["value", "kind", "allowed_hosts"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where("name", "=", "github-connection")
        .where("deleted_at_ms", "is", null),
    );
    if (row) {
      if (row.kind !== "secret" || row.allowed_hosts !== null) {
        throw new PersonalGitHubStateError();
      }
      try {
        assertSecretStoreValueLength(row.value, "secret");
      } catch (error) {
        if (error instanceof SecretStoreValidationError) {
          throw new PersonalGitHubStateError();
        }
        throw error;
      }
      registerSecretValueForRedaction(row.value);
    }
    return row?.value;
  }, undefined);
}

/** The caller owns the synchronous profile/connection transaction and its preconditions. */
export function writePersonalGitHubSecret(
  db: DatabaseSync,
  profileId: string,
  value: string | null,
): void {
  const query = getNodeSqliteKysely<HiddenGitHubStoreDatabase>(db);
  if (value === null) {
    executeSqliteQuerySync(
      db,
      query
        .deleteFrom("secret_store_entries")
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", profileId)
        .where("name", "=", "github-connection"),
    );
    return;
  }
  assertSecretStoreValueLength(value, "secret");
  ensureSecretStoreSchema(db);
  const now = Date.now();
  upsertHiddenGitHubSecret(
    db,
    {
      scope_kind: "identity",
      scope_id: profileId,
      name: "github-connection",
      value,
      updated_by: null,
    },
    now,
  );
  registerSecretValueForRedaction(value);
}

function upsertHiddenGitHubSecret(
  db: DatabaseSync,
  entry: Pick<HiddenGitHubStoreRow, "scope_kind" | "scope_id" | "name" | "value" | "updated_by">,
  now: number,
): void {
  const values = {
    value: entry.value,
    updated_by: entry.updated_by,
    kind: "secret",
    allowed_hosts: null,
    deleted_at_ms: null,
    updated_at_ms: now,
  };
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<HiddenGitHubStoreDatabase>(db)
      .insertInto("secret_store_entries")
      .values({ ...entry, ...values, created_at_ms: now })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(values),
      ),
  );
}

function isLiveHiddenGitHubStoreRow(
  row: Pick<HiddenGitHubStoreRow, "created_at_ms" | "updated_at_ms">,
  kind: "device" | "oauth",
  now: number,
): boolean {
  const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
  const updatedAtMs = normalizeSqliteNumber(row.updated_at_ms);
  return (
    createdAtMs !== undefined &&
    updatedAtMs !== undefined &&
    createdAtMs <= now &&
    (kind !== "device" || createdAtMs > now - GITHUB_DEVICE_STORE_MAX_AGE_MS)
  );
}

function selectHiddenGitHubSecretRecords(sqlite: DatabaseSync) {
  return getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite)
    .selectFrom("secret_store_entries")
    .select(["name", "value", "created_at_ms", "updated_at_ms"])
    .where("scope_kind", "=", "team")
    .where("scope_id", "=", "")
    .where("kind", "=", "secret")
    .where("allowed_hosts", "is", null)
    .where("deleted_at_ms", "is", null);
}

export function writeHiddenGitHubSecretInDatabase(
  sqlite: DatabaseSync,
  params: { name: string; value: string; updatedBy?: string | null; now: number },
): void {
  assertHiddenGitHubSecretRecordName(params.name);
  assertSecretStoreValueLength(params.value, "secret");
  ensureSecretStoreSchema(sqlite);
  upsertHiddenGitHubSecret(
    sqlite,
    {
      scope_kind: "team",
      scope_id: "",
      name: params.name,
      value: params.value,
      updated_by: params.updatedBy ?? null,
    },
    params.now,
  );
}

export function readHiddenGitHubSecretInDatabase(
  sqlite: DatabaseSync,
  name: string,
  now: number,
): string | undefined {
  const kind = assertHiddenGitHubSecretRecordName(name);
  return withMissingSecretStoreFallback(() => {
    const row = executeSqliteQueryTakeFirstSync(
      sqlite,
      selectHiddenGitHubSecretRecords(sqlite).where("name", "=", name),
    );
    return row && isLiveHiddenGitHubStoreRow(row, kind, now) ? row.value : undefined;
  }, undefined);
}

export function listHiddenGitHubSecretsInDatabase(
  sqlite: DatabaseSync,
  prefix: HiddenGitHubStorePrefix,
  now: number,
): Array<{ name: string; value: string }> {
  const kind = hiddenGitHubStoreKindFromPrefix(prefix);
  return withMissingSecretStoreFallback(
    () =>
      executeSqliteQuerySync(
        sqlite,
        selectHiddenGitHubSecretRecords(sqlite)
          .where("name", ">=", `${prefix}-`)
          .where("name", "<", `${prefix}.`)
          .orderBy("name", "asc"),
      ).rows.flatMap((row) =>
        classifyHiddenGitHubStoreName(row.name) === kind &&
        isLiveHiddenGitHubStoreRow(row, kind, now)
          ? [{ name: row.name, value: row.value }]
          : [],
      ),
    [],
  );
}

export function deleteHiddenGitHubSecretInDatabase(sqlite: DatabaseSync, name: string): void {
  assertHiddenGitHubSecretRecordName(name);
  withMissingSecretStoreFallback(
    () =>
      executeSqliteQuerySync(
        sqlite,
        getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite)
          .deleteFrom("secret_store_entries")
          .where("scope_kind", "=", "team")
          .where("scope_id", "=", "")
          .where("name", "=", name),
      ),
    undefined,
  );
}
