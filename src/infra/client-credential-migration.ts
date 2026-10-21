import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { chunkItems } from "../utils/chunk-items.js";
import {
  sourceRows,
  validateSource,
  extractSocket,
  hashClientCredentialRows,
  resolveClientCredentialLegacyImportClaims,
  type LegacyDatabase,
} from "./client-credential-migration-data.js";
import { resolveStateClientCredentialEnvironment } from "./client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import {
  readClientCredentialFileIdentity,
  serializeClientCredentialReceipt,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import {
  CLIENT_CREDENTIAL_SCHEMA_VERSION,
  CLIENT_CREDENTIAL_SOURCE_TABLES,
  type ClientCredentialDatabase,
} from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { readEngineAnchor } from "./database-engine/open.js";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import { hasSqlitePostCommitScope, stageSqliteTransactionState } from "./sqlite-post-commit.js";
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

function postgresBootstrapProvenance(
  source: EngineConnection,
): NonNullable<ClientCredentialReceipt["source"]> | undefined {
  const postgres = isPostgresSqlConnection(source);
  const rows = readEngineAnchor(postgres ? source.anchor : source, "identity", postgres);
  if (!rows) {
    return undefined;
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.engine !== "postgres" ||
    typeof row.store_id !== "string" ||
    !row.store_id.trim() ||
    typeof row.schema !== "string" ||
    !row.schema.trim()
  ) {
    throw new Error("Invalid PostgreSQL anchor identity during client credential bootstrap.");
  }
  return {
    kind: "canonical",
    engine: "postgres",
    identity: row.store_id,
    generation: `bootstrap:${row.store_id}`,
    sha256: hashClientCredentialRows({ identities: [], tokens: [], origins: [], approvals: [] }),
    destinationVersion: CLIENT_CREDENTIAL_SCHEMA_VERSION,
  };
}

export function readClientCredentialBootstrapSource(
  source: EngineConnection,
  pathname: string,
): NonNullable<ClientCredentialReceipt["source"]> {
  const postgres = postgresBootstrapProvenance(source);
  if (postgres) {
    return postgres;
  }
  const metadata = source
    .prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'")
    .get();
  if (!metadata) {
    throw new Error("Shared credential source identity was not published.");
  }
  return {
    kind: "canonical",
    engine: "sqlite",
    identity: `${pathname}:${String(metadata.created_at)}`,
    generation: `bootstrap:${String(metadata.created_at)}`,
    sha256: hashClientCredentialRows({ identities: [], tokens: [], origins: [], approvals: [] }),
    destinationVersion: CLIENT_CREDENTIAL_SCHEMA_VERSION,
  };
}

function isPristineSqliteBootstrap(
  database: DatabaseSync,
  previous: ReturnType<typeof readClientCredentialReceipt>,
): boolean {
  const source = previous?.receipt.source;
  const file = previous?.receipt.sharedFile;
  if (
    previous?.phase !== "complete" ||
    source?.kind !== "canonical" ||
    source.engine !== "sqlite" ||
    !file ||
    !source.generation.startsWith("bootstrap:") ||
    source.generation === "bootstrap:" ||
    source.identity !== `${file.path}:${source.generation.slice("bootstrap:".length)}` ||
    source.sha256 !==
      hashClientCredentialRows({ identities: [], tokens: [], origins: [], approvals: [] }) ||
    Object.keys(previous.receipt.legacyImports).length !== 0
  ) {
    return false;
  }
  const db = getNodeSqliteKysely<ClientCredentialDatabase>(database);
  return (
    [
      "device_identities",
      "device_auth_tokens",
      "gateway_origin_device_tokens",
      "native_exec_socket_credentials",
    ] as const
  ).every(
    (table) =>
      !executeSqliteQueryTakeFirstSync(database, db.selectFrom(table).selectAll().limit(1)),
  );
}

/** Fresh shared bootstrap binds existing local-only credentials without replacing them. */
export function bindFreshClientCredentialStore(
  source: EngineConnection,
  options: { path: string; env: NodeJS.ProcessEnv },
): void {
  if (!source.isTransaction || !hasSqlitePostCommitScope(source)) {
    throw new Error("Client credential bootstrap has no source commit lifecycle.");
  }
  // Auxiliary shared-schema files do not select a native client credential owner.
  const env = resolveStateClientCredentialEnvironment(options);
  if (!env) {
    return;
  }
  // A fresh PG anchor exists before its first network connection or schema metadata.
  const postgres = postgresBootstrapProvenance(source);
  const target = openClientCredentialCustody(env, {
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
    const db = getNodeSqliteKysely<ClientCredentialDatabase>(target.database);
    const previousRow = executeSqliteQueryTakeFirstSync(
      target.database,
      db.selectFrom("client_credential_migration").selectAll().where("version", "=", 1),
    );
    const sharedFile = readClientCredentialFileIdentity(options.path);
    if (!sharedFile) {
      throw new Error("Shared credential source is missing during bootstrap.");
    }
    const previousSource = previous?.receipt.source;
    const previousFile = previous?.receipt.sharedFile;
    const sameSharedFile =
      previousFile?.path === sharedFile.path &&
      previousFile.dev === sharedFile.dev &&
      previousFile.ino === sharedFile.ino;
    const samePostgresBootstrap =
      postgres &&
      previousSource?.kind === postgres.kind &&
      previousSource.engine === postgres.engine &&
      previousSource.identity === postgres.identity &&
      previousSource.generation === postgres.generation &&
      previousSource.sha256 === postgres.sha256 &&
      previousSource.destinationVersion === postgres.destinationVersion &&
      sameSharedFile;
    // An untouched empty SQLite bootstrap has no credentials or consumed imports to reassign.
    const pristineSqliteBootstrap =
      !postgres && isPristineSqliteBootstrap(target.database, previous);
    if (
      (previousSource && !samePostgresBootstrap && !pristineSqliteBootstrap) ||
      (previousFile && !sameSharedFile && !pristineSqliteBootstrap)
    ) {
      throw new Error(
        "Existing client credentials belong to a previous shared database; run openclaw doctor --fix.",
      );
    }
    const receipt: ClientCredentialReceipt = {
      format: 1,
      // A new file cannot carry the previous source's identity while awaiting its commit.
      source:
        pristineSqliteBootstrap && !sameSharedFile ? null : (previous?.receipt.source ?? null),
      sharedFile,
      legacyImports: previous?.receipt.legacyImports ?? {},
    };
    runSqliteImmediateTransactionSync(target.database, () =>
      writeClientCredentialReceipt(target.database, receipt, "copied"),
    );
    if (
      !stageSqliteTransactionState(source, {
        stage() {},
        commit() {
          try {
            // Persist the committed database identity so a later remount can be recovered.
            receipt.source = readClientCredentialBootstrapSource(source, sharedFile.path);
            runSqliteImmediateTransactionSync(target.database, () =>
              writeClientCredentialReceipt(target.database, receipt, "complete"),
            );
            publication?.complete();
          } finally {
            close();
          }
        },
        rollback() {
          try {
            runSqliteImmediateTransactionSync(target.database, () => {
              if (previousRow) {
                executeSqliteQuerySync(
                  target.database,
                  db
                    .insertInto("client_credential_migration")
                    .values(previousRow)
                    .onConflict((conflict) => conflict.column("version").doUpdateSet(previousRow)),
                );
              } else {
                executeSqliteQuerySync(
                  target.database,
                  db.deleteFrom("client_credential_migration").where("version", "=", 1),
                );
              }
            });
            publication?.complete();
          } finally {
            close();
          }
        },
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
  const env = resolveStateClientCredentialEnvironment(options);
  if (!env) {
    return;
  }
  const target = openClientCredentialCustody(env, {
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
    if (stored.phase === "complete" && sameFile && !sameNativeBootstrap && provenance) {
      return;
    }
    // A bootstrap interrupted after source commit still has the original file fence.
    stored.receipt.source ??= readClientCredentialBootstrapSource(source, file.path);
    stored.receipt.sharedFile = file;
    target.transaction(() =>
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
  const env = resolveStateClientCredentialEnvironment(options);
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const capture =
    options.capture ??
    getUpdateDoctorMigrationSource(options.path) ??
    (isPostgresSqlConnection(source)
      ? undefined
      : getDoctorMigrationBackup(source, {
          path: options.path,
          env: env ?? options.env,
          tables: [...CLIENT_CREDENTIAL_SOURCE_TABLES, "sqlite_stat1", "sqlite_stat4"],
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
  if (!env) {
    throw new Error(
      "Client credentials in an auxiliary shared database require explicit recovery; preserve the source database.",
    );
  }
  assertStateDatabaseAccessAllowed(options.path);
  maintenance.assertAdmission();
  capture.assertCurrent();
  const rows = sourceRows(
    source,
    nativeBootstrap || options.fromVersion < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1,
  );
  const authTablePresent = !nativeBootstrap || tableExists(source, "device_auth_tokens");
  // Move canonical identities exactly; explicit local Doctor repair owns invalid material.
  validateSource(rows, nativeBootstrap ? "require-valid" : "preserve-for-doctor");
  const extracted = extractSocket(rows.approvals[0]);
  const file = readClientCredentialFileIdentity(options.path);
  if (!file) {
    throw new Error("Client credential source disappeared before migration.");
  }
  const sourceHasMetadata = tableExists(source, "schema_meta");
  const preMetadata = options.fromVersion === 1 && !sourceHasMetadata;
  const metadata =
    (nativeBootstrap || preMetadata) && !sourceHasMetadata
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
    legacyImports: resolveClientCredentialLegacyImportClaims(source, {
      identities: rows.identities,
      nativeBootstrap,
      authTablePresent,
    }),
  };
  const target = openClientCredentialCustody(env, {
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
      if (previous) {
        // Rebuilding derived rows never makes a consumed legacy input eligible again.
        receipt.legacyImports = { ...receipt.legacyImports, ...previous.receipt.legacyImports };
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
      // Bound statement parameters for SQLite builds with the default variable limit.
      for (const batch of chunkItems(rows.identities, 500)) {
        executeSqliteQuerySync(database, db.insertInto("device_identities").values(batch));
      }
      for (const batch of chunkItems(rows.tokens, 500)) {
        executeSqliteQuerySync(database, db.insertInto("device_auth_tokens").values(batch));
      }
      for (const batch of chunkItems(rows.origins, 500)) {
        executeSqliteQuerySync(
          database,
          db.insertInto("gateway_origin_device_tokens").values(batch),
        );
      }
      if (extracted.socket) {
        executeSqliteQuerySync(
          database,
          db.insertInto("native_exec_socket_credentials").values(extracted.socket),
        );
      }
      executeSqliteQuerySync(
        database,
        db.insertInto("client_credential_migration").values({
          version: 1,
          source_store: serializeClientCredentialReceipt(
            receipt,
            path.dirname(path.dirname(target.path)),
          ),
          phase: "copied",
          updated_at_ms: Date.now(),
        }),
      );
    });
    if (
      !stageSqliteTransactionState(source, {
        stage() {},
        prepareCommit() {
          if (!preMetadata) {
            return;
          }
          // Canonical repair creates the source identity; copied recovery must know it before COMMIT.
          const preparedMetadata = source
            .prepare("SELECT created_at FROM schema_meta WHERE meta_key = 'primary'")
            .get();
          if (!preparedMetadata || !receipt.source) {
            throw new Error("Historical client credential source identity was not published.");
          }
          receipt.source.identity = `${file.path}:${String(preparedMetadata.created_at)}`;
          runSqliteImmediateTransactionSync(target.database, () =>
            writeClientCredentialReceipt(target.database, receipt, "copied"),
          );
        },
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
