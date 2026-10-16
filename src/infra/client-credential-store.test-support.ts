import type { DatabaseSync } from "node:sqlite";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

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
