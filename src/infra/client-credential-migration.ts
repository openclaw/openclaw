import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import {
  sourceRows,
  validateSource,
  extractSocket,
  hashClientCredentialRows,
  type LegacyDatabase,
} from "./client-credential-migration-data.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import {
  readClientCredentialFileIdentity,
  serializeClientCredentialReceipt,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_VERSION } from "./client-credential-schema.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { readEngineAnchor } from "./database-engine/open.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import { stageSqliteTransactionState } from "./sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  beginUpdateSqliteCompanion,
  getDoctorMigrationBackup,
  getUpdateDoctorMigrationSource,
} from "./update-doctor-migration-attribution.js";

export type ClientCredentialMigrationCapture = {
  path: string;
  generation: string;
  assertCurrent(): void;
};

const CLIENT_CREDENTIAL_SOURCE_TABLES = [
  "device_identities",
  "device_auth_tokens",
  "gateway_origin_device_tokens",
  "exec_approvals_config",
] as const;

/** Fresh shared bootstrap binds existing local-only credentials without replacing them. */
export function bindFreshClientCredentialStore(
  source: EngineConnection,
  options: { path: string; env: NodeJS.ProcessEnv },
): void {
  const target = openClientCredentialCustody(options.env, {
    createIfMissing: true,
    migration: true,
  });
  if (!target) {
    throw new Error("Cannot acquire local credentials during shared bootstrap.");
  }
  const close = () => target.close();
  try {
    const publication = beginUpdateSqliteCompanion(target.database, target.path, target.created);
    const previous = readClientCredentialReceipt(target.database);
    const sharedFile = readClientCredentialFileIdentity(options.path);
    if (previous?.receipt.source) {
      throw new Error(
        "Existing client credentials belong to a previous shared database; run openclaw doctor --fix.",
      );
    }
    const receipt: ClientCredentialReceipt = previous?.receipt ?? {
      format: 1,
      source: null,
      sharedFile: null,
      legacyImports: {},
    };
    receipt.sharedFile = sharedFile;
    runSqliteImmediateTransactionSync(target.database, () =>
      writeClientCredentialReceipt(target.database, receipt, "copied"),
    );
    if (
      !stageSqliteTransactionState(source, {
        stage() {},
        commit() {
          try {
            runSqliteImmediateTransactionSync(target.database, () =>
              writeClientCredentialReceipt(target.database, receipt, "complete"),
            );
            publication?.complete();
          } finally {
            close();
          }
        },
        rollback: close,
        invalidate: close,
      })
    ) {
      throw new Error("Client credential bootstrap has no source commit lifecycle.");
    }
  } catch (error) {
    close();
    throw error;
  }
}

/** Resume publication after the shared transaction committed but its local completion did not. */
export function recoverClientCredentialStore(
  source: EngineConnection,
  options: { path: string; env: NodeJS.ProcessEnv },
): void {
  const metadata = source
    .prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  if (
    readStateSchemaContentVersion(source) < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION ||
    CLIENT_CREDENTIAL_SOURCE_TABLES.slice(0, 3).some((table) => tableExists(source, table))
  ) {
    throw new Error(
      "Shared credentials are still authoritative; complete their migration before using the local store.",
    );
  }
  const target = openClientCredentialCustody(options.env, {
    createIfMissing: false,
    migration: true,
  });
  if (!target) {
    throw new Error(
      "Local credentials are missing; restore the matching client credential backup.",
    );
  }
  try {
    const stored = readClientCredentialReceipt(target.database);
    if (!stored) {
      throw new Error("Local credential receipt is missing; restore its matching backup.");
    }
    const file = readClientCredentialFileIdentity(options.path);
    if (!file) {
      throw new Error("Shared credential source is missing; restore its matching backup.");
    }
    const provenance = stored.receipt.source;
    const original = stored.receipt.sharedFile;
    const sameFile =
      original?.path === file.path && original.dev === file.dev && original.ino === file.ino;
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
    if (provenance) {
      const identity = isPostgresSqlConnection(source)
        ? String(readEngineAnchor(source.anchor, "identity", true)?.[0]?.store_id)
        : `${file.path}:${String(metadata?.created_at ?? 0)}`;
      const sameNativeBootstrap =
        provenance.kind === "canonical" && provenance.engine === "native-v0" && sameFile;
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
    stored.receipt.sharedFile = file;
    runSqliteImmediateTransactionSync(target.database, () =>
      writeClientCredentialReceipt(target.database, stored.receipt, "complete"),
    );
  } finally {
    target.close();
  }
}

/** Shared schema custody already owns the source transaction; this retains local custody until its outcome. */
export function prepareClientCredentialMigration(
  source: EngineConnection,
  options: {
    path: string;
    env: NodeJS.ProcessEnv;
    fromVersion: number;
    capture?: ClientCredentialMigrationCapture;
  },
): void {
  if (
    options.fromVersion >= CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION ||
    (isPostgresSqlConnection(source) &&
      options.fromVersion !== CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1)
  ) {
    return;
  }
  if (!source.isTransaction) {
    throw new Error("Client credential migration requires the shared owner's transaction.");
  }
  const nativeBootstrap = options.fromVersion === 0;
  if (
    nativeBootstrap &&
    !CLIENT_CREDENTIAL_SOURCE_TABLES.some((table) => tableExists(source, table))
  ) {
    bindFreshClientCredentialStore(source, options);
    return;
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const capture =
    options.capture ??
    getUpdateDoctorMigrationSource(options.path) ??
    (isPostgresSqlConnection(source)
      ? undefined
      : getDoctorMigrationBackup(source, {
          path: options.path,
          env: options.env,
          tables: CLIENT_CREDENTIAL_SOURCE_TABLES,
        })?.capture);
  if (
    !maintenance?.ownsSchemaMaintenance ||
    !capture ||
    capture.path !== options.path ||
    !capture.generation
  ) {
    throw new Error(
      "Client credentials require backed-up migration custody; stop the app and run openclaw doctor --fix.",
    );
  }
  maintenance.assertDatabaseAccess(options.path);
  maintenance.assertAdmission();
  capture.assertCurrent();
  const rows = sourceRows(
    source,
    nativeBootstrap || options.fromVersion < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1,
  );
  const authTablePresent = !nativeBootstrap || tableExists(source, "device_auth_tokens");
  validateSource(rows);
  const extracted = extractSocket(rows.approvals[0]);
  const file = readClientCredentialFileIdentity(options.path);
  if (!file) {
    throw new Error("Client credential source disappeared before migration.");
  }
  const metadata =
    nativeBootstrap && !tableExists(source, "schema_meta")
      ? undefined
      : source.prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'").get();
  const anchor = isPostgresSqlConnection(source)
    ? readEngineAnchor(source.anchor, "identity", true)?.[0]
    : undefined;
  const receipt: ClientCredentialReceipt = {
    format: 1,
    source: {
      kind: "canonical",
      engine: isPostgresSqlConnection(source)
        ? "postgres"
        : nativeBootstrap
          ? "native-v0"
          : "sqlite",
      identity: anchor
        ? String(anchor.store_id)
        : `${file.path}:${String(metadata?.created_at ?? 0)}`,
      generation: capture.generation,
      sha256: hashClientCredentialRows(rows, nativeBootstrap ? { authTablePresent } : undefined),
      destinationVersion: CLIENT_CREDENTIAL_SCHEMA_VERSION,
    },
    sharedFile: file,
    legacyImports: {},
  };
  for (const row of rows.identities) {
    if (
      row.identity_key === "primary" ||
      row.identity_key === "node" ||
      row.identity_key === "shareExtension"
    ) {
      receipt.legacyImports[`identity:${row.identity_key}`] = { sha256: null };
      // Only an existing token table makes absence authoritative for native bootstraps.
      if (authTablePresent) {
        receipt.legacyImports[`auth:${row.identity_key}`] = { sha256: null };
      }
    }
  }
  if (
    !nativeBootstrap &&
    tableExists(source, "migration_sources") &&
    source
      .prepare(
        "SELECT 1 FROM migration_sources WHERE migration_kind = 'legacy-device-identity-json' LIMIT 1",
      )
      .get()
  ) {
    receipt.legacyImports["identity:primary"] = { sha256: null };
  }
  const target = openClientCredentialCustody(options.env, {
    createIfMissing: true,
    migration: true,
  });
  if (!target) {
    throw new Error("Client credential migration could not acquire local custody.");
  }
  const close = () => target.close();
  try {
    const publication = beginUpdateSqliteCompanion(target.database, target.path, target.created);
    runSqliteImmediateTransactionSync(target.database, () => {
      const database = target.database;
      const previous = readClientCredentialReceipt(database);
      if (nativeBootstrap && previous?.receipt.source?.kind === "independent") {
        // Rebuilding derived rows never makes a consumed legacy input eligible again.
        receipt.legacyImports = { ...previous.receipt.legacyImports, ...receipt.legacyImports };
      }
      const independent =
        previous?.phase === "complete" &&
        previous.receipt.source?.kind === "independent" &&
        nativeBootstrap &&
        previous.receipt.source.identity === `${file.dev}:${file.ino}` &&
        previous.receipt.source.sha256 === receipt.source!.sha256 &&
        previous.receipt.sharedFile?.path === file.path &&
        previous.receipt.sharedFile.dev === file.dev &&
        previous.receipt.sharedFile.ino === file.ino;
      if (independent) {
        writeClientCredentialReceipt(database, receipt, "copied");
        return;
      }
      // A canonical predecessor still holding these rows owns them, even after in-place rollback.
      const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
      for (const table of [
        "device_identities",
        "device_auth_tokens",
        "gateway_origin_device_tokens",
        "native_exec_socket_credentials",
        "client_credential_migration",
      ] as const) {
        executeSqliteQuerySync(database, db.deleteFrom(table));
      }
      if (rows.identities.length) {
        executeSqliteQuerySync(
          database,
          db.insertInto("device_identities").values(rows.identities),
        );
      }
      if (rows.tokens.length) {
        executeSqliteQuerySync(database, db.insertInto("device_auth_tokens").values(rows.tokens));
      }
      if (rows.origins.length) {
        executeSqliteQuerySync(
          database,
          db.insertInto("gateway_origin_device_tokens").values(rows.origins),
        );
      }
      if (extracted.socket) {
        executeSqliteQuerySync(
          database,
          db.insertInto("native_exec_socket_credentials").values(extracted.socket),
        );
      }
      const copied = {
        identities: executeSqliteQuerySync(
          database,
          db.selectFrom("device_identities").selectAll().orderBy("identity_key"),
        ).rows,
        tokens: executeSqliteQuerySync(
          database,
          db.selectFrom("device_auth_tokens").selectAll().orderBy("device_id").orderBy("role"),
        ).rows,
        origins: executeSqliteQuerySync(
          database,
          db
            .selectFrom("gateway_origin_device_tokens")
            .selectAll()
            .orderBy("gateway_scope")
            .orderBy("device_id")
            .orderBy("role"),
        ).rows,
        sockets: executeSqliteQuerySync(
          database,
          db.selectFrom("native_exec_socket_credentials").selectAll(),
        ).rows,
      };
      if (
        stableStringify(copied) !==
        stableStringify({
          identities: rows.identities,
          tokens: rows.tokens,
          origins: rows.origins,
          sockets: extracted.socket ? [extracted.socket] : [],
        })
      ) {
        throw new Error(
          "Client credential migration verification failed; shared credentials were retained.",
        );
      }
      executeSqliteQuerySync(
        database,
        db.insertInto("client_credential_migration").values({
          version: 1,
          source_store: serializeClientCredentialReceipt(receipt),
          phase: "copied",
          updated_at_ms: Date.now(),
        }),
      );
    });
    if (
      !stageSqliteTransactionState(source, {
        stage() {},
        commit() {
          try {
            // Fresh SQLite bootstrap has its durable identity only after this commit.
            if (
              nativeBootstrap &&
              !isPostgresSqlConnection(source) &&
              tableExists(source, "schema_meta")
            ) {
              const committedMetadata = source
                .prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'")
                .get();
              if (receipt.source) {
                receipt.source.engine = "sqlite";
                receipt.source.identity = `${file.path}:${String(committedMetadata?.created_at ?? 0)}`;
              }
            }
            runSqliteImmediateTransactionSync(target.database, () =>
              writeClientCredentialReceipt(target.database, receipt, "complete"),
            );
            publication?.complete();
          } finally {
            close();
          }
        },
        rollback: close,
        invalidate: close,
      })
    ) {
      throw new Error("Client credential migration has no source commit lifecycle.");
    }
    maintenance.assertAdmission();
    capture.assertCurrent();
    if (rows.approvals[0] && extracted.policy !== undefined) {
      executeSqliteQuerySync(
        source,
        getNodeSqliteKysely<LegacyDatabase>(source)
          .updateTable("exec_approvals_config")
          .set({ raw_json: extracted.policy, socket_path: null, has_socket_token: 0 })
          .where("config_key", "=", "current"),
      );
    }
    source.exec(
      "DROP TABLE IF EXISTS device_auth_tokens; DROP TABLE IF EXISTS device_identities; DROP TABLE IF EXISTS gateway_origin_device_tokens;",
    );
  } catch (error) {
    close();
    throw error;
  }
}
