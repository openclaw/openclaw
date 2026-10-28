import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";

type SecretDatabase = Pick<DB, "secret_store_entries">;

/** A fixed-width private name keeps self-hosted issuer URLs out of secret metadata. */
export function gitLabConnectionSecretName(issuer: string): string {
  return `gitlab-connection-${createHash("sha256").update(issuer).digest("hex")}`;
}

export function readPersonalGitLabSecret(
  db: EngineConnection,
  owner: string,
  issuer: string,
): string | undefined {
  return withMissingSecretStoreFallback(() => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<SecretDatabase>(db)
        .selectFrom("secret_store_entries")
        .select(["value", "kind", "allowed_hosts"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", owner)
        .where("name", "=", gitLabConnectionSecretName(issuer))
        .where("deleted_at_ms", "is", null),
    );
    if (row) {
      if (row.kind !== "secret" || row.allowed_hosts !== null) {
        throw new Error("Personal GitLab state is invalid; reconnect My GitLab.");
      }
      assertSecretStoreValueLength(row.value, "secret");
      registerSecretValueForRedaction(row.value);
    }
    return row?.value;
  }, undefined);
}

/** Must run in the profile owner worker's admitted write transaction. */
export function writePersonalGitLabSecret(
  db: EngineConnection,
  owner: string,
  issuer: string,
  value: string,
): void {
  assertSecretStoreValueLength(value, "secret");
  ensureSecretStoreSchema(db);
  const now = Date.now();
  const values = {
    value,
    updated_by: null,
    kind: "secret" as const,
    allowed_hosts: null,
    deleted_at_ms: null,
    updated_at_ms: now,
  };
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SecretDatabase>(db)
      .insertInto("secret_store_entries")
      .values({
        scope_kind: "identity",
        scope_id: owner,
        name: gitLabConnectionSecretName(issuer),
        ...values,
        created_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(values),
      ),
  );
  registerSecretValueForRedaction(value);
}

/** A profile merge retires source custody without adopting it at the target. */
export function retirePersonalGitLabSecrets(
  db: EngineConnection,
  sourceOwners: readonly string[],
): void {
  if (sourceOwners.length === 0) {
    return;
  }
  withMissingSecretStoreFallback(() => {
    const query = getNodeSqliteKysely<SecretDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      query
        .selectFrom("secret_store_entries")
        .select(["scope_id", "name"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "in", [...sourceOwners])
        .where("name", ">=", "gitlab-")
        .where("name", "<", "gitlab."),
    );
    for (const row of rows.rows) {
      if (!/^gitlab-connection-[a-f0-9]{64}$/u.test(row.name)) {
        continue;
      }
      executeSqliteQuerySync(
        db,
        query
          .deleteFrom("secret_store_entries")
          .where("scope_kind", "=", "identity")
          .where("scope_id", "=", row.scope_id)
          .where("name", "=", row.name),
      );
    }
  }, undefined);
}
