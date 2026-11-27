import { randomBytes } from "node:crypto";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

type SecretStoreDatabase = Pick<DB, "secret_store_entries">;

const TEAM_SCOPE = { scopeKind: "team", scopeId: "" } as const;
/** 16 hex characters (64 random bits) after `_` still fit the 128-character name limit. */
const CONFIG_REF_NAME_BASE_MAX = 111;
const CONFIG_REF_NAME_MINT_ATTEMPTS = 4;

export type SecretStoreConfigRefWrite = {
  /** Preferred entry name derived from the config path. */
  baseName: string;
  value: string;
  writer: string;
  now: number;
};

/**
 * Saves a chat-provided secret for one config key under a freshly minted name,
 * `NAME_<16 random hex>`. A predictable name could match a stale SecretRef
 * whose entry was removed and purged, handing that consumer this key; a random
 * suffix never names an entry anything already points at. No existing row is
 * touched. `admit` fences the write with the requester's live authority at
 * transaction and commit.
 */
export function writeSecretStoreEntryForConfigRefInDatabase(
  input: SecretStoreConfigRefWrite,
  databaseOptions?: OpenClawStateDatabaseOptions,
  admit?: (stage: "transaction" | "commit") => void,
): { name: string } {
  const base = input.baseName.slice(0, CONFIG_REF_NAME_BASE_MAX);
  if (!ENV_SECRET_REF_ID_RE.test(base)) {
    throw new Error(`Secret store name "${base}" is invalid.`);
  }
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      admit?.("transaction");
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      for (let attempt = 0; attempt < CONFIG_REF_NAME_MINT_ATTEMPTS; attempt += 1) {
        const name = `${base}_${randomBytes(8).toString("hex").toUpperCase()}`;
        const taken = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("name")
            .where("scope_kind", "=", TEAM_SCOPE.scopeKind)
            .where("scope_id", "=", TEAM_SCOPE.scopeId)
            .where("name", "=", name),
        );
        if (taken) {
          continue;
        }
        executeSqliteQuerySync(
          sqlite,
          db.insertInto("secret_store_entries").values({
            scope_kind: TEAM_SCOPE.scopeKind,
            scope_id: TEAM_SCOPE.scopeId,
            name,
            value: input.value,
            kind: "secret",
            created_at_ms: input.now,
            updated_at_ms: input.now,
            updated_by: input.writer,
            deleted_at_ms: null,
            allowed_hosts: null,
          }),
        );
        admit?.("commit");
        return { name };
      }
      throw new Error("Could not mint an unused secret store name; try again.");
    },
    databaseOptions,
    { operationLabel: "secrets.store.write-config-ref" },
  );
}
