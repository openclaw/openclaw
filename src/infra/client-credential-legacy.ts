import type { ClientIdentityRecord, ClientTokenRecord } from "./client-credential-operations.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import type { ClientCredentialLegacyKey } from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import type { ClientCredentialCustody } from "./client-credential-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

/** Validated rows and their immutable consumed claim commit under the same owner. */
export function importClientCredentialLegacy(
  owner: ClientCredentialCustody,
  input: {
    key: ClientCredentialLegacyKey;
    sha256: string | null;
    identity?: ClientIdentityRecord;
    tokens?: ClientTokenRecord[];
  },
): boolean {
  return owner.transaction(() => {
    const stored = readClientCredentialReceipt(owner.database);
    if (!stored || stored.phase !== "complete") {
      throw new Error("Client credential migration must complete before legacy import.");
    }
    if (stored.receipt.legacyImports[input.key]) {
      return false;
    }
    const db = getNodeSqliteKysely<ClientCredentialDatabase>(owner.database);
    if (input.identity) {
      executeSqliteQuerySync(
        owner.database,
        db
          .insertInto("device_identities")
          .values(input.identity)
          .onConflict((conflict) => conflict.column("identity_key").doNothing()),
      );
    }
    for (const token of input.tokens ?? []) {
      executeSqliteQuerySync(
        owner.database,
        db
          .insertInto("device_auth_tokens")
          .values(token)
          .onConflict((conflict) => conflict.columns(["device_id", "role"]).doNothing()),
      );
    }
    stored.receipt.legacyImports[input.key] = { sha256: input.sha256 };
    writeClientCredentialReceipt(owner.database, stored.receipt, "complete");
    return true;
  });
}
