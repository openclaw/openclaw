import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import type { BackupManifest } from "../commands/backup-verify-manifest.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { readIndependentClientCredentialSource } from "./client-credential-native-bootstrap.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import {
  readClientCredentialFileIdentity,
  parseClientCredentialReceipt,
  type ClientCredentialFileIdentity,
} from "./client-credential-receipt.js";
import type { ClientCredentialRehearsalBinding } from "./client-credential-restore-contract.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { readEngineAnchor } from "./database-engine/open.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";

const portBindingSchema = z.strictObject({
  localFile: z.strictObject({
    path: z.string(),
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
  }),
  receipt: z.string(),
});

function portSharedIdentity(snapshotPath: string, sharedPath: string) {
  using database = openNodeSqliteDatabase(snapshotPath, { readOnly: true, readBigInts: true });
  const anchor = readEngineAnchor(database)?.[0];
  if (anchor) {
    if (typeof anchor.store_id !== "string") {
      throw new Error("Database port PostgreSQL identity is missing.");
    }
    return { engine: "postgres" as const, identity: anchor.store_id };
  }
  const createdAt = database // sqlite-allow-raw -- Port binds the verified image's immutable shared-store identity.
    .prepare("SELECT created_at FROM schema_meta WHERE meta_key='primary'")
    .get()?.created_at;
  if (typeof createdAt !== "bigint") {
    throw new Error("Database port shared identity is missing.");
  }
  return { engine: "sqlite" as const, identity: `${sharedPath}:${createdAt}` };
}

/** Capture only receipt metadata; credential rows remain in their existing local owner. */
export function capturePortClientCredentialBinding(options: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceFile: ClientCredentialFileIdentity;
}): z.infer<typeof portBindingSchema> | null {
  using owner = openClientCredentialCustody(options.env, { migration: true });
  if (!owner) {
    return null;
  }
  const stored = readClientCredentialReceipt(owner.database);
  const identity = portSharedIdentity(options.sourcePath, options.sourceFile.path);
  if (
    stored?.phase !== "complete" ||
    !isDeepStrictEqual(stored.receipt.sharedFile, options.sourceFile) ||
    (stored.receipt.source &&
      (stored.receipt.source.kind !== "canonical" ||
        stored.receipt.source.engine !== identity.engine ||
        stored.receipt.source.identity !== identity.identity))
  ) {
    throw new Error("Database port credentials do not match the captured shared database.");
  }
  const localFile = readClientCredentialFileIdentity(owner.path);
  if (!localFile) {
    throw new Error("Database port local credentials disappeared.");
  }
  return { localFile, receipt: JSON.stringify(stored.receipt) };
}

/** Called after durable port completion, when recovery can resume but cannot roll back. */
export function rebindPortedClientCredentials(options: {
  env: NodeJS.ProcessEnv;
  binding: unknown;
  sharedPath: string;
  sqliteSnapshotPath: string;
  engine: "sqlite" | "postgres";
  storeId: string;
  assertCurrent: () => void;
}): void {
  const binding = portBindingSchema.nullable().parse(options.binding);
  using owner = openClientCredentialCustody(options.env, { migration: true });
  if (!binding && !owner) {
    return;
  }
  if (
    !binding ||
    !owner ||
    !isDeepStrictEqual(readClientCredentialFileIdentity(owner.path), binding.localFile)
  ) {
    throw new Error("Database port local credentials no longer match their capture.");
  }
  const original = {
    phase: "complete" as const,
    receipt: parseClientCredentialReceipt(binding.receipt),
  };
  const sharedFile = readClientCredentialFileIdentity(options.sharedPath);
  const identity = portSharedIdentity(options.sharedPath, options.sharedPath);
  const expectedIdentity =
    options.engine === "postgres"
      ? options.storeId
      : portSharedIdentity(options.sqliteSnapshotPath, options.sharedPath).identity;
  if (!sharedFile || identity.engine !== options.engine || identity.identity !== expectedIdentity) {
    throw new Error("Database port target does not match its verified shared identity.");
  }
  const replacement = {
    ...original,
    receipt: {
      ...original.receipt,
      sharedFile,
      source: original.receipt.source ? { ...original.receipt.source, ...identity } : null,
    },
  };
  owner.transaction(() => {
    const stored = readClientCredentialReceipt(owner.database);
    if (isDeepStrictEqual(stored, replacement)) {
      return;
    }
    if (!isDeepStrictEqual(stored, original)) {
      throw new Error("Database port credential receipt no longer matches its capture.");
    }
    options.assertCurrent();
    writeClientCredentialReceipt(owner.database, replacement.receipt, "complete");
  });
}

/** Doctor supplies the original identity only after a verified byte-identical rewrite. */
export function rebindRewrittenClientCredentials(options: {
  env: NodeJS.ProcessEnv;
  previousSharedFile: ClientCredentialFileIdentity;
  assertCurrent: () => void;
}): void {
  using owner = openClientCredentialCustody(options.env, { migration: true });
  if (!owner) {
    return;
  }
  owner.transaction(() => {
    const stored = readClientCredentialReceipt(owner.database);
    const original = stored?.receipt.sharedFile;
    if (!stored || !original) {
      return;
    }
    const previous = options.previousSharedFile;
    if (
      original.path !== previous.path ||
      original.dev !== previous.dev ||
      original.ino !== previous.ino
    ) {
      throw new Error("Rewritten credential source is not the recorded generation.");
    }
    const replacement = readClientCredentialFileIdentity(previous.path);
    if (!replacement) {
      throw new Error("Rewritten credential source is missing.");
    }
    stored.receipt.sharedFile = replacement;
    if (stored.receipt.source?.kind === "independent") {
      stored.receipt.source.identity = `${replacement.dev}:${replacement.ino}`;
    }
    options.assertCurrent();
    writeClientCredentialReceipt(owner.database, stored.receipt, stored.phase);
  });
}

function prepareMatchedReceipt(options: {
  localPath: string;
  sharedPath: string;
  originalSharedPath: string;
  originalStateRoot: string;
  restoredSharedPath: string;
  originalSharedFile?: ClientCredentialFileIdentity;
  postgresStoreId?: string;
  postgresExportDirectory?: string;
  projectPostgresToSqlite?: boolean;
  preserveCopiedPhase?: boolean;
}) {
  using local = openNodeSqliteDatabase(options.localPath, { readOnly: true });
  const stored = readClientCredentialReceipt(local, options.originalStateRoot);
  if (!stored?.receipt.sharedFile) {
    return null;
  }
  const original = stored.receipt.sharedFile;
  const source = stored.receipt.source;
  if (
    (stored.phase !== "complete" && !options.preserveCopiedPhase) ||
    original.path !== options.originalSharedPath
  ) {
    throw new Error("Restored client credentials do not match the captured shared database.");
  }
  if (source?.kind === "independent") {
    const native = readIndependentClientCredentialSource(options.sharedPath);
    if (native.sha256 !== source.sha256) {
      throw new Error("Restored native credentials have a different source snapshot.");
    }
  } else {
    using database = openNodeSqliteDatabase(options.sharedPath, { readOnly: true });
    const anchor = readEngineAnchor(database)?.[0];
    if (anchor) {
      if (!options.postgresExportDirectory) {
        throw new Error("Restored client credentials are missing their PostgreSQL capture.");
      }
      using capturedAnchor = openNodeSqliteDatabase(
        path.join(options.postgresExportDirectory, "anchor.sqlite"),
        { readOnly: true },
      );
      const captured = readEngineAnchor(capturedAnchor)?.[0];
      if (
        (options.postgresStoreId && options.postgresStoreId !== anchor.store_id) ||
        captured?.store_id !== anchor.store_id ||
        captured?.schema !== anchor.schema ||
        (source && (source.engine !== "postgres" || source.identity !== anchor.store_id))
      ) {
        throw new Error("Restored client credentials have a different PostgreSQL identity.");
      }
      using image = openNodeSqliteDatabase(
        path.join(options.postgresExportDirectory, "database.sqlite"),
        { readOnly: true },
      );
      if (readStateSchemaContentVersion(image) < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION) {
        return null;
      }
      if (options.projectPostgresToSqlite && source) {
        const createdAt = image // sqlite-allow-raw -- Private rehearsal projects the verified export's immutable store identity.
          .prepare("SELECT created_at FROM schema_meta WHERE meta_key='primary'")
          .get()?.created_at;
        source.engine = "sqlite";
        source.identity = `${options.restoredSharedPath}:${String(createdAt)}`;
      }
      // A fresh binding has no migration source. Its verified shared/local capture
      // still belongs together; the restore owner alone may replace the inode witness.
    } else {
      if (options.postgresStoreId) {
        throw new Error("Restored client credentials are missing their PostgreSQL anchor.");
      }
      // A restored predecessor owns its rows; its ignored local orphan remains fenced.
      if (readStateSchemaContentVersion(database) < CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION) {
        return null;
      }
      const createdAt = database // sqlite-allow-raw -- Matched restore reads immutable shared-store identity metadata.
        .prepare("SELECT created_at FROM schema_meta WHERE meta_key='primary'")
        .get()?.created_at;
      if (
        source &&
        (source.engine !== "sqlite" || source.identity !== `${original.path}:${String(createdAt)}`)
      ) {
        throw new Error("Restored client credentials have a different shared database identity.");
      }
      if (source) {
        source.identity = `${options.restoredSharedPath}:${String(createdAt)}`;
      }
    }
  }
  if (
    options.originalSharedFile &&
    (original.dev !== options.originalSharedFile.dev ||
      original.ino !== options.originalSharedFile.ino)
  ) {
    throw new Error("Restored client credentials do not match the captured shared database.");
  }
  return stored;
}

function publishRestoredReceipt(
  stored: NonNullable<ReturnType<typeof prepareMatchedReceipt>>,
  sharedPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const { receipt } = stored;
  const restored = readClientCredentialFileIdentity(sharedPath);
  if (!restored) {
    throw new Error("Restored shared database is missing.");
  }
  using owner = openClientCredentialCustody(env, { createIfMissing: false, migration: true });
  if (!owner) {
    throw new Error("Restored local credentials are missing.");
  }
  if (receipt.source?.kind === "independent") {
    receipt.source.identity = `${restored.dev}:${restored.ino}`;
  }
  receipt.sharedFile = restored;
  runSqliteImmediateTransactionSync(owner.database, () =>
    writeClientCredentialReceipt(owner.database, receipt, stored.phase),
  );
}

/** The snapshot owner supplies only the admitted shared/local pair and its source witness. */
export function rebindRehearsalClientCredentials(options: ClientCredentialRehearsalBinding): void {
  const receipt = prepareMatchedReceipt({
    localPath: options.localPath,
    sharedPath: options.postgresExportDirectory
      ? path.join(options.postgresExportDirectory, "anchor.sqlite")
      : options.sharedPath,
    originalSharedPath: options.sourceSharedFile.path,
    originalStateRoot: options.sourceStateRoot,
    originalSharedFile: options.sourceSharedFile,
    restoredSharedPath: options.sharedPath,
    postgresStoreId: options.postgresStoreId,
    postgresExportDirectory: options.postgresExportDirectory,
    projectPostgresToSqlite: Boolean(options.postgresExportDirectory),
    preserveCopiedPhase: true,
  });
  if (receipt) {
    publishRestoredReceipt(receipt, options.sharedPath, {
      OPENCLAW_STATE_DIR: path.dirname(path.dirname(options.localPath)),
    });
  }
}

/** Validate archive captures before their owner publishes the final shared/local pair. */
export function prepareRestoredClientCredentials(options: {
  manifest: BackupManifest;
  targetPath: string;
}): (() => void) | undefined {
  const { manifest, targetPath } = options;
  const state = manifest.assets.find((asset) => asset.kind === "state");
  const shared = manifest.sqliteSnapshots?.find((snapshot) => snapshot.role === "global");
  if (!state || !shared) {
    return undefined;
  }
  const stateDir = path.join(targetPath, state.archivePath);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const localPath = resolveClientCredentialStorePath(env);
  if (!fs.existsSync(localPath)) {
    return undefined;
  }
  const sharedPath = path.join(
    targetPath,
    buildBackupArchivePath(manifest.archiveRoot, shared.sourcePath),
  );
  const receipt = prepareMatchedReceipt({
    localPath,
    sharedPath,
    originalSharedPath: manifest.paths?.sharedDatabaseSourcePath ?? shared.sourcePath,
    originalStateRoot: manifest.paths?.stateDir ?? state.sourcePath,
    restoredSharedPath: sharedPath,
    // The export is nested beneath this manifest-declared global snapshot.
    postgresExportDirectory: `${sharedPath}.postgres`,
  });
  if (receipt) {
    return () => publishRestoredReceipt(receipt, sharedPath, env);
  }
  return undefined;
}

/** Validate captured bytes before replacement; publish only under the restore owner's custody. */
export function prepareUpdateClientCredentialRestore(options: {
  backup: UpdateDatabaseBackup;
  env: NodeJS.ProcessEnv;
}): (() => void) | undefined {
  const sharedPath = resolvePathViaExistingAncestorSync(
    resolveOpenClawStateSqlitePath(options.env),
  );
  const localPath = resolvePathViaExistingAncestorSync(
    resolveClientCredentialStorePath(options.env),
  );
  const shared = options.backup.databases.find((entry) => entry.path === sharedPath);
  const local = options.backup.databases.find((entry) => entry.path === localPath);
  // Published pre-cutover drivers have no local image. Their orphan remains fenced.
  if (!shared || !local) {
    return undefined;
  }
  const receipt = prepareMatchedReceipt({
    localPath: local.snapshotPath,
    sharedPath: shared.snapshotPath,
    originalSharedPath: sharedPath,
    originalStateRoot: path.dirname(path.dirname(localPath)),
    restoredSharedPath: sharedPath,
    postgresStoreId: shared.storeId,
    postgresExportDirectory: shared.exportDirectory,
  });
  if (receipt) {
    return () => publishRestoredReceipt(receipt, sharedPath, options.env);
  }
  return undefined;
}
