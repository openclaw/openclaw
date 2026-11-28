import type { DatabaseSync } from "node:sqlite";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveStateClientCredentialEnvironment } from "./client-credential-paths.js";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import {
  isSameClientCredentialFile,
  readClientCredentialFileIdentity,
} from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SOURCE_TABLES } from "./client-credential-schema.js";
import { hasClientCredentialStoreMigrationWork } from "./client-credential-store.js";
import { readEngineAnchor } from "./database-engine/open.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";

// Recovery decisions shared by the credential owner's Doctor recovery and its read-only plan.

/** Pre-cutover stores still keep their credentials in the shared database. */
export function hasAuthoritativeSharedClientCredentials(source: EngineConnection): boolean {
  return (
    readStateSchemaContentVersion(source) < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION ||
    CLIENT_CREDENTIAL_SOURCE_TABLES.slice(0, 3).some((table) => tableExists(source, table))
  );
}

/**
 * The receipt decision `recoverClientCredentialStore` acts on: "complete" when the local
 * receipt already records this shared file, otherwise the receipt to rewrite. It throws for a
 * missing or mismatched receipt, as recovery does.
 */
export function planClientCredentialReceiptRecovery(
  source: EngineConnection,
  database: DatabaseSync,
  sharedPath: string,
):
  | { kind: "complete" }
  | {
      kind: "rewrite";
      stored: NonNullable<ReturnType<typeof readClientCredentialReceipt>>;
      file: NonNullable<ReturnType<typeof readClientCredentialFileIdentity>>;
    } {
  const metadata = source
    .prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  const stored = readClientCredentialReceipt(database);
  if (!stored) {
    throw new Error("Local credential receipt is missing; restore its matching backup.");
  }
  const file = readClientCredentialFileIdentity(sharedPath);
  if (!file) {
    throw new Error("Shared credential source is missing; restore its matching backup.");
  }
  const provenance = stored.receipt.source;
  const original = stored.receipt.sharedFile;
  const sameFile = isSameClientCredentialFile(original, file);
  if (!provenance && !sameFile) {
    throw new Error(
      "Local credentials do not match the shared database; restore their matched backup.",
    );
  }
  if (provenance?.kind === "independent") {
    throw new Error(
      "Independent native credentials require copy admission, not canonical recovery.",
    );
  }
  const sameNativeBootstrap =
    provenance?.kind === "canonical" && provenance.engine === "native-v0" && sameFile;
  if (provenance) {
    const identity = isPostgresSqlConnection(source)
      ? String(readEngineAnchor(source.anchor, "identity", true)?.[0]?.store_id)
      : `${file.path}:${String(metadata?.created_at ?? 0)}`;
    if (provenance.identity !== identity && !sameNativeBootstrap) {
      throw new Error(
        "Local credentials do not match the shared database; restore their matched backup.",
      );
    }
    if (sameNativeBootstrap) {
      provenance.engine = isPostgresSqlConnection(source) ? "postgres" : "sqlite";
      provenance.identity = identity;
    }
  }
  // A renumbered device falls through so recovery records the current binding.
  if (
    stored.phase === "complete" &&
    sameFile &&
    original?.dev === file.dev &&
    !sameNativeBootstrap &&
    provenance
  ) {
    return { kind: "complete" };
  }
  return { kind: "rewrite", stored, file };
}

/**
 * Read-only: whether current-schema Doctor repair of `source` would act on the local
 * credential store: refuse it (shared credentials still authoritative, a missing, unsafe
 * or unadmittable store, a missing or mismatched receipt) or rewrite its receipt.
 */
export function hasClientCredentialStoreRecoveryWork(
  source: DatabaseSync,
  options: { path: string; env: NodeJS.ProcessEnv },
): boolean {
  if (hasAuthoritativeSharedClientCredentials(source)) {
    return true;
  }
  const env = resolveStateClientCredentialEnvironment(options);
  if (!env) {
    return false;
  }
  return hasClientCredentialStoreMigrationWork(env, (database) => {
    try {
      return (
        planClientCredentialReceiptRecovery(source, database, options.path).kind !== "complete"
      );
    } catch {
      return true;
    }
  });
}
