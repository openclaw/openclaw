import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readIndependentClientCredentialSource } from "./client-credential-native-bootstrap.js";
import {
  CLIENT_CREDENTIAL_LEGACY_KEYS,
  emptyClientCredentialReceipt,
  parseClientCredentialReceipt,
  readClientCredentialFileIdentity,
  serializeClientCredentialReceipt,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { StartupMaintenanceRequiredError } from "./startup-maintenance-required.js";

function notReady(): Error {
  return new Error(
    "Client credential migration is incomplete or stale; run openclaw doctor --fix before using this client.",
  );
}

export function readClientCredentialReceipt(
  database: DatabaseSync,
): { phase: "copied" | "complete"; receipt: ClientCredentialReceipt } | null {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("client_credential_migration").selectAll().where("version", "=", 1),
  );
  return row ? { phase: row.phase, receipt: parseClientCredentialReceipt(row.source_store) } : null;
}

export function writeClientCredentialReceipt(
  database: DatabaseSync,
  receipt: ClientCredentialReceipt,
  phase: "copied" | "complete",
  now = Date.now(),
): void {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  const row = {
    version: 1 as const,
    source_store: serializeClientCredentialReceipt(receipt),
    phase,
    updated_at_ms: now,
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("client_credential_migration")
      .values(row)
      .onConflict((conflict) => conflict.column("version").doUpdateSet(row)),
  );
}

function assertClientCredentialLegacyReady(
  database: DatabaseSync | null,
  env: NodeJS.ProcessEnv,
  sealAbsent = false,
  knownReceipt?: ClientCredentialReceipt,
): void {
  let changed = false;
  const db = database ? getNodeSqliteKysely<ClientCredentialDatabase>(database) : undefined;
  const receipt =
    knownReceipt ?? (database ? readClientCredentialReceipt(database)?.receipt : undefined);
  const filenames = {
    primary: "device",
    node: "node-device",
    shareExtension: "share-device",
  } as const;
  for (const profile of ["primary", "node", "shareExtension"] as const) {
    for (const kind of ["identity", "auth"] as const) {
      if (receipt?.legacyImports[`${kind}:${profile}`]) {
        continue;
      }
      const filename = `${filenames[profile]}${kind === "auth" ? "-auth" : ""}.json`;
      const pathname = path.join(resolveStateDir(env), "identity", filename);
      if (
        [pathname, `${pathname}.doctor-importing`, `${pathname}.native-importing`].some(
          (candidate) => fs.existsSync(candidate),
        )
      ) {
        if (
          kind === "identity" &&
          database &&
          db &&
          executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("device_identities")
              .select("identity_key")
              .where("identity_key", "=", profile),
          )
        ) {
          continue;
        }
        throw new StartupMaintenanceRequiredError(
          "state-migrations",
          "Legacy client credentials require migration; run openclaw doctor --fix before using this client.",
        );
      }
      if (sealAbsent && receipt) {
        receipt.legacyImports[`${kind}:${profile}`] = { sha256: null };
        changed = true;
      }
    }
  }
  if (changed && receipt && database) {
    writeClientCredentialReceipt(database, receipt, "complete");
  }
}

export function assertMissingClientCredentialStoreReady(env: NodeJS.ProcessEnv): void {
  assertClientCredentialLegacyReady(null, env);
  if (readClientCredentialFileIdentity(resolveOpenClawStateSqlitePath(env))) {
    throw notReady();
  }
}

function prepareClientCredentialReceipt(
  database: DatabaseSync,
  env: NodeJS.ProcessEnv,
  initialize: boolean,
  readOnly = false,
) {
  const sharedFile = readClientCredentialFileIdentity(resolveOpenClawStateSqlitePath(env));
  let stored = readClientCredentialReceipt(database);
  if (!stored && initialize && !sharedFile) {
    assertClientCredentialLegacyReady(null, env);
    const receipt = emptyClientCredentialReceipt();
    for (const key of CLIENT_CREDENTIAL_LEGACY_KEYS) {
      receipt.legacyImports[key] = { sha256: null };
    }
    writeClientCredentialReceipt(database, receipt, "complete");
    stored = { phase: "complete", receipt };
  }
  if (!stored || stored.phase !== "complete") {
    throw notReady();
  }
  if (stored.receipt.source?.kind === "independent") {
    const previous = stored.receipt.sharedFile!;
    const source = readIndependentClientCredentialSource(previous.path);
    if (
      source.identity !== stored.receipt.source.identity ||
      source.file.path !== previous.path ||
      source.file.dev !== previous.dev ||
      source.file.ino !== previous.ino ||
      source.sha256 !== stored.receipt.source.sha256
    ) {
      if (readOnly) {
        throw new Error(
          "Independent client credentials changed; open the client or run openclaw doctor --fix before read-only inspection.",
        );
      }
      const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
      // A restored native source replaces its derived rows. Consumed JSON stays consumed.
      executeSqliteQuerySync(database, db.deleteFrom("device_auth_tokens"));
      executeSqliteQuerySync(database, db.deleteFrom("device_identities"));
      executeSqliteQuerySync(database, db.deleteFrom("gateway_origin_device_tokens"));
      if (source.rows.identities.length) {
        executeSqliteQuerySync(
          database,
          db.insertInto("device_identities").values(source.rows.identities),
        );
      }
      if (source.rows.tokens.length) {
        executeSqliteQuerySync(
          database,
          db.insertInto("device_auth_tokens").values(source.rows.tokens),
        );
      }
      stored.receipt.source = {
        kind: "independent",
        engine: "native-v0",
        identity: source.identity,
        generation: "0",
        sha256: source.sha256,
        destinationVersion: 1,
      };
      stored.receipt.sharedFile = source.file;
      writeClientCredentialReceipt(database, stored.receipt, "complete");
    }
  } else {
    const previous = stored.receipt.sharedFile;
    if (
      previous === null
        ? sharedFile !== null
        : sharedFile === null ||
          previous.path !== sharedFile.path ||
          previous.dev !== sharedFile.dev ||
          previous.ino !== sharedFile.ino
    ) {
      throw notReady();
    }
  }
  return stored;
}

/** Canonical receipts never open the selected Gateway database. */
export function assertClientCredentialStoreReady(
  database: DatabaseSync,
  env: NodeJS.ProcessEnv,
  initialize: boolean,
): void {
  prepareClientCredentialReceipt(database, env, initialize);
}

/** Admit once under the local owner's existing transaction and native custody. */
export function admitClientCredentialStore(
  database: DatabaseSync,
  env: NodeJS.ProcessEnv,
  options: { initialize: boolean; readOnly: boolean },
): void {
  const stored = prepareClientCredentialReceipt(
    database,
    env,
    options.initialize,
    options.readOnly,
  );
  assertClientCredentialLegacyReady(database, env, !options.readOnly, stored.receipt);
}
