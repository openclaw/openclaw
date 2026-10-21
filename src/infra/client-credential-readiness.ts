import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { chunkItems } from "../utils/chunk-items.js";
import { readIndependentClientCredentialSource } from "./client-credential-native-bootstrap.js";
import {
  CLIENT_CREDENTIAL_LEGACY_KEYS,
  emptyClientCredentialReceipt,
  parseClientCredentialReceipt,
  readClientCredentialFileIdentity,
  serializeClientCredentialReceipt,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import {
  CLIENT_CREDENTIAL_SCHEMA_VERSION,
  type ClientCredentialDatabase,
} from "./client-credential-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { StartupMaintenanceRequiredError } from "./startup-maintenance-required.js";

export class ClientCredentialMigrationRequiredError extends StartupMaintenanceRequiredError {
  constructor(
    message = "Client credential migration is incomplete or stale; run openclaw doctor --fix before using this client.",
  ) {
    super("state-migrations", message);
    this.name = "ClientCredentialMigrationRequiredError";
  }
}

function notReady(): Error {
  return new ClientCredentialMigrationRequiredError();
}

type ClientCredentialReceiptState = {
  phase: "copied" | "complete";
  receipt: ClientCredentialReceipt;
};

function assertSupportedVersion(version: number): void {
  if (version !== CLIENT_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error(
      `Client credentials have unsupported schema version ${String(version)}. Use a compatible OpenClaw version.`,
    );
  }
}

/** The receipt is a cross-process migration-phase guard, including in-place copied → complete transitions. */
export function readClientCredentialAdmission(database: DatabaseSync): {
  version: number;
  stored: ClientCredentialReceiptState | null;
} {
  let row: Record<string, SQLOutputValue> | undefined;
  try {
    row =
      // sqlite-allow-raw -- Read the native header and its migration receipt in one bounded statement.
      database
        .prepare(`
    SELECT header.user_version, receipt.source_store, receipt.phase
    FROM pragma_user_version AS header
    LEFT JOIN client_credential_migration AS receipt ON receipt.version = 1
  `)
        .get();
  } catch (error) {
    // A newer schema may change the receipt's SQL shape before this query can read its version.
    assertSupportedVersion(readSqliteUserVersion(database));
    throw error;
  }
  if (!row || typeof row.user_version !== "number") {
    throw notReady();
  }
  assertSupportedVersion(row.user_version);
  const localPath = database.location();
  return {
    version: row.user_version,
    stored:
      row.source_store === null
        ? null
        : {
            phase: row.phase === "complete" ? "complete" : "copied",
            receipt: parseClientCredentialReceipt(
              String(row.source_store),
              localPath ? path.dirname(path.dirname(localPath)) : undefined,
            ),
          },
  };
}

export function readClientCredentialReceipt(
  database: DatabaseSync,
  rootPath?: string,
): ClientCredentialReceiptState | null {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("client_credential_migration").selectAll().where("version", "=", 1),
  );
  const localPath = database.location();
  return row
    ? {
        phase: row.phase,
        receipt: parseClientCredentialReceipt(
          row.source_store,
          rootPath ?? (localPath ? path.dirname(path.dirname(localPath)) : undefined),
        ),
      }
    : null;
}

export function writeClientCredentialReceipt(
  database: DatabaseSync,
  receipt: ClientCredentialReceipt,
  phase: "copied" | "complete",
  now = Date.now(),
): void {
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  const localPath = database.location();
  const row = {
    version: 1 as const,
    source_store: serializeClientCredentialReceipt(
      receipt,
      localPath ? path.dirname(path.dirname(localPath)) : undefined,
    ),
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
        throw new ClientCredentialMigrationRequiredError(
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
  knownReceipt = readClientCredentialReceipt(database),
) {
  let stored = knownReceipt;
  const sharedFile = readClientCredentialFileIdentity(resolveOpenClawStateSqlitePath(env));
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
      for (const batch of chunkItems(source.rows.identities, 500)) {
        executeSqliteQuerySync(database, db.insertInto("device_identities").values(batch));
      }
      for (const batch of chunkItems(source.rows.tokens, 500)) {
        executeSqliteQuerySync(database, db.insertInto("device_auth_tokens").values(batch));
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
  options: {
    initialize: boolean;
    readOnly: boolean;
    stored?: ClientCredentialReceiptState | null;
  },
): void {
  const stored = prepareClientCredentialReceipt(
    database,
    env,
    options.initialize,
    options.readOnly,
    options.stored,
  );
  assertClientCredentialLegacyReady(database, env, !options.readOnly, stored.receipt);
}
