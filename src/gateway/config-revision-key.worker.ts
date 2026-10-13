import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureConfigRevisionKeySchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

/** Return the installation key without rotating existing revision or response-session tokens. */
export function loadOrCreateConfigRevisionKeyInDatabase(
  database: DatabaseSync,
  candidateKey: Uint8Array,
): Uint8Array {
  ensureConfigRevisionKeySchema(database);
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "config_revision_keys">>(database)
      .insertInto("config_revision_keys")
      .values({ id: 1, hmac_key: candidateKey })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) => ({
          hmac_key: eb.ref("config_revision_keys.hmac_key"),
        })),
      )
      .returning("hmac_key"),
  );
  if (!stored) {
    throw new Error("config revision key could not be created");
  }
  return stored.hmac_key;
}
