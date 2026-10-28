import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  assertHiddenGitLabSecretRecordName,
  classifyHiddenGitLabStoreName,
  GITLAB_SETUP_STORE_MAX_AGE_MS,
  hiddenGitLabStoreKindFromPrefix,
  type HiddenGitLabStorePrefix,
} from "./secret-store-managed-gitlab-names.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";
type HiddenGitLabStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;
type HiddenGitLabStoreRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;
function upsertHiddenGitLabSecret(
  db: EngineConnection,
  entry: Pick<HiddenGitLabStoreRow, "scope_kind" | "scope_id" | "name" | "value" | "updated_by">,
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
    getNodeSqliteKysely<HiddenGitLabStoreDatabase>(db)
      .insertInto("secret_store_entries")
      .values({ ...entry, ...values, created_at_ms: now })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(values),
      ),
  );
}

function isLiveHiddenGitLabStoreRow(
  row: Pick<HiddenGitLabStoreRow, "created_at_ms" | "updated_at_ms">,
  kind: "setup" | "oauth",
  now: number,
): boolean {
  const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
  const updatedAtMs = normalizeSqliteNumber(row.updated_at_ms);
  return (
    createdAtMs !== undefined &&
    updatedAtMs !== undefined &&
    createdAtMs <= now &&
    (kind !== "setup" || createdAtMs > now - GITLAB_SETUP_STORE_MAX_AGE_MS)
  );
}

function selectHiddenGitLabSecretRecords(sqlite: EngineConnection) {
  return getNodeSqliteKysely<HiddenGitLabStoreDatabase>(sqlite)
    .selectFrom("secret_store_entries")
    .select(["name", "value", "created_at_ms", "updated_at_ms"])
    .where("scope_kind", "=", "team")
    .where("scope_id", "=", "")
    .where("kind", "=", "secret")
    .where("allowed_hosts", "is", null)
    .where("deleted_at_ms", "is", null);
}

export function writeHiddenGitLabSecretInDatabase(
  sqlite: EngineConnection,
  params: {
    name: string;
    value: string;
    expectedValue?: string;
    expectedAbsent?: boolean;
    updatedBy?: string | null;
    now: number;
  },
): void {
  assertHiddenGitLabSecretRecordName(params.name);
  assertSecretStoreValueLength(params.value, "secret");
  if (
    params.expectedValue !== undefined &&
    readHiddenGitLabSecretInDatabase(sqlite, params.name, params.now) !== params.expectedValue
  ) {
    throw new Error("GitLab OAuth record changed before settlement");
  }
  if (
    params.expectedAbsent &&
    readHiddenGitLabSecretInDatabase(sqlite, params.name, params.now) !== undefined
  ) {
    throw new Error("GitLab managed record already exists");
  }
  ensureSecretStoreSchema(sqlite);
  upsertHiddenGitLabSecret(
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

export function readHiddenGitLabSecretInDatabase(
  sqlite: EngineConnection,
  name: string,
  now: number,
): string | undefined {
  const kind = assertHiddenGitLabSecretRecordName(name);
  return withMissingSecretStoreFallback(() => {
    const row = executeSqliteQueryTakeFirstSync(
      sqlite,
      selectHiddenGitLabSecretRecords(sqlite).where("name", "=", name),
    );
    return row && isLiveHiddenGitLabStoreRow(row, kind, now) ? row.value : undefined;
  }, undefined);
}

export function listHiddenGitLabSecretsInDatabase(
  sqlite: EngineConnection,
  prefix: HiddenGitLabStorePrefix | undefined,
  now: number,
): Array<{ name: string; value: string }> {
  const kind = prefix === undefined ? undefined : hiddenGitLabStoreKindFromPrefix(prefix);
  return withMissingSecretStoreFallback(
    () =>
      executeSqliteQuerySync(
        sqlite,
        selectHiddenGitLabSecretRecords(sqlite)
          .where((eb) =>
            eb.or(
              (prefix === undefined ? ["gitlab-setup", "gitlab-oauth"] : [prefix]).map((selected) =>
                eb.and([eb("name", ">=", `${selected}-`), eb("name", "<", `${selected}.`)]),
              ),
            ),
          )
          .orderBy("name", "asc"),
      ).rows.flatMap((row) => {
        const rowKind = classifyHiddenGitLabStoreName(row.name);
        return (rowKind === "setup" || rowKind === "oauth") &&
          (kind === undefined || rowKind === kind) &&
          isLiveHiddenGitLabStoreRow(row, rowKind, now)
          ? [{ name: row.name, value: row.value }]
          : [];
      }),
    [],
  );
}

export function deleteHiddenGitLabSecretInDatabase(sqlite: EngineConnection, name: string): void {
  assertHiddenGitLabSecretRecordName(name);
  withMissingSecretStoreFallback(
    () =>
      executeSqliteQuerySync(
        sqlite,
        getNodeSqliteKysely<HiddenGitLabStoreDatabase>(sqlite)
          .deleteFrom("secret_store_entries")
          .where("scope_kind", "=", "team")
          .where("scope_id", "=", "")
          .where("name", "=", name),
      ),
    undefined,
  );
}
