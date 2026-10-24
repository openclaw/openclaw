import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { SECRET_STORE_VALUE_MAX_BYTES } from "../secrets/store/secret-store-validation-error.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { UserModelAccountRecordName } from "./user-model-account-records.kernel.js";

// Callers own the admitted transaction and credential/links publication.
export function writeUserModelAccountRecord(
  db: EngineConnection,
  owner: string,
  name: UserModelAccountRecordName,
  value: string,
): void {
  if (Buffer.byteLength(value, "utf8") > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new Error("Personal model account entry exceeds the 64 KiB secret-store limit.");
  }
  ensureSecretStoreSchema(db);
  const now = Date.now();
  const mutable = {
    value,
    kind: "secret",
    allowed_hosts: null,
    deleted_at_ms: null,
    updated_at_ms: now,
    updated_by: null,
  };
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .insertInto("secret_store_entries")
      .values({ scope_kind: "identity", scope_id: owner, name, created_at_ms: now, ...mutable })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(mutable),
      ),
  );
}

export function deleteUserModelAccountCredentialRecord(
  db: EngineConnection,
  owner: string,
  authProfileId: string,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .deleteFrom("secret_store_entries")
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", owner)
      .where("name", "=", `model-account:${authProfileId}`),
  );
}
