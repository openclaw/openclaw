import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export function createLegacyNodeAuthFixture(deviceId: string) {
  const token = {
    device_id: deviceId,
    role: "node",
    token: "revoked-node-json-token",
    scopes_json: "[]",
    updated_at_ms: 12,
  };
  const raw = JSON.stringify({
    version: 1,
    deviceId: token.device_id,
    tokens: {
      node: { token: token.token, role: "node", scopes: [], updatedAtMs: 12 },
    },
  });
  return {
    token,
    raw,
    legacyImport: {
      key: "auth:node" as const,
      sha256: createHash("sha256").update(raw).digest("hex"),
      tokens: [token],
    },
  };
}

/** Raw fixture setup and inspection close their admitted owner before returning. */
export function withClientCredentialStore<T>(
  env: NodeJS.ProcessEnv,
  createIfMissing: boolean,
  operation: (db: DatabaseSync) => T,
): T | undefined {
  using owner = openClientCredentialCustody(env, { createIfMissing, migration: true });
  return owner
    ? runSqliteImmediateTransactionSync(owner.database, () => operation(owner.database))
    : undefined;
}
