import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import * as tar from "tar";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import {
  recordArchiveSymbolicLink,
  type BackupSymbolicLink,
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry-listing.js";
import { resolveUserPath } from "../utils.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO, buildBackupArchivePath } from "./backup-shared.js";
import {
  type BackupManifest,
  backupManifestSizeError,
  isRootBackupManifestEntry,
  parseBackupManifest,
  verifyBackupManifestEntries,
} from "./backup-verify-manifest.js";

const MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES = 64 * 1024 * 1024 * 1024;
const SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
  symlinkCount: number;
  externalSymbolicLinks?: BackupSymbolicLink[];
};

type PreparedBackupArchive = {
  result: BackupVerifyResult;
  hardlinkTargets: ReadonlyMap<string, string>;
  symbolicLinks: BackupSymbolicLink[];
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  size?: number;
  type?: string;
};

type NormalizedArchiveEntry = {
  raw: string;
  normalized: string;
  size?: number;
  type?: string;
};

type SqliteSnapshotIdentity = { role: "global" } | { role: "agent"; agentId: string };

type SqliteSnapshotEntry = NormalizedArchiveEntry & SqliteSnapshotIdentity;

type ExpectedSqliteRole = "agent" | "global";

async function listArchiveEntries(archivePath: string) {
  const entries: ArchiveEntry[] = [];
  let invalidReason: string | undefined;
  await tar.t({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    onwarn: (code, message) => {
      // tar skips invalid headers; a readable remainder is not a complete backup.
      if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ENTRY_INVALID") {
        invalidReason ??= formatErrorMessage(message);
      }
    },
    onReadEntry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
    },
  });
  return { entries, invalidReason };
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  let manifestContentPromise: Promise<Buffer | Error> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    filter: (entryPath) => entryPath === params.manifestEntryPath,
    onReadEntry: (entry) => {
      manifestContentPromise = Promise.resolve(
        backupManifestSizeError(entry.size) ??
          entry.concat().catch((error: unknown) => toStringifiedError(error)),
      );
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  const content = await manifestContentPromise;
  if (content instanceof Error) {
    throw content;
  }
  return content.toString("utf8");
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
    `Symbolic links checked: ${result.symlinkCount}`,
  ].join("\n");
}

function resolvePortableArchivePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function findPortableArchiveEntryPathCollision(
  entries: Array<{ normalized: string }>,
): { first: string; second: string } | undefined {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = resolvePortableArchivePathKey(entry.normalized);
    const first = seen.get(key);
    if (first && first !== entry.normalized) {
      return { first, second: entry.normalized };
    }
    seen.set(key, entry.normalized);
  }
  return undefined;
}

function isRegularArchiveFile(entryType: string | undefined): boolean {
  return entryType === "File" || entryType === "OldFile" || entryType === "ContiguousFile";
}

function resolveCanonicalStateAssetRoot(manifest: BackupManifest): string | undefined {
  const stateAssets = manifest.assets.filter((asset) => asset.kind === "state");
  if (stateAssets.length === 0) {
    return undefined;
  }
  if (stateAssets.length !== 1) {
    throw new Error(
      `Backup manifest must contain at most one state asset; found ${stateAssets.length}.`,
    );
  }

  const stateAsset = stateAssets[0];
  if (!stateAsset) {
    return undefined;
  }

  const stateAssetRoot = normalizeArchivePath(
    stateAsset.archivePath,
    "Backup manifest state asset path",
  );
  const expectedStateAssetRoot = buildBackupArchivePath(
    normalizeArchiveRoot(manifest.archiveRoot),
    stateAsset.sourcePath,
  );
  if (stateAssetRoot !== expectedStateAssetRoot) {
    throw new Error("Backup manifest state asset archivePath does not match its sourcePath.");
  }
  return stateAssetRoot;
}

type SqliteSnapshotOwner = { archivePath: string } & SqliteSnapshotIdentity;

function listSqliteSnapshotEntries(
  entries: NormalizedArchiveEntry[],
  owners: SqliteSnapshotOwner[],
): SqliteSnapshotEntry[] {
  const ownersByPath = new Map(
    owners.map((owner) => [resolvePortableArchivePathKey(owner.archivePath), owner]),
  );
  const snapshots: SqliteSnapshotEntry[] = [];
  for (const entry of entries) {
    const portablePath = resolvePortableArchivePathKey(entry.normalized);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      if (
        portablePath.endsWith(suffix) &&
        ownersByPath.has(portablePath.slice(0, -suffix.length))
      ) {
        throw new Error(`Backup contains a SQLite snapshot sidecar: ${entry.normalized}`);
      }
    }
    const owner = ownersByPath.get(portablePath);
    if (!owner) {
      continue;
    }
    if (entry.normalized !== owner.archivePath) {
      throw new Error(`Backup contains a case-mangled canonical SQLite path: ${entry.normalized}`);
    }
    if (!isRegularArchiveFile(entry.type)) {
      throw new Error(`SQLite snapshot must be a regular archive file: ${entry.normalized}`);
    }
    snapshots.push({ ...entry, ...owner });
  }
  return snapshots;
}

function readArchivedAgentDatabaseOwners(
  database: DatabaseSync,
  manifest: BackupManifest,
  stateDir: string,
): SqliteSnapshotOwner[] {
  const rows = readOpenClawAgentDatabaseRegistryRows(database, stateDir);
  // Resolve the producer's paths, not the verifier host's filesystem paths.
  const sourcePath = manifest.platform === "win32" ? path.win32 : path.posix;
  return rows.map((row) => ({
    archivePath: buildBackupArchivePath(
      manifest.archiveRoot,
      sourcePath.isAbsolute(row.path) ? row.path : sourcePath.join(stateDir, row.path),
    ),
    role: "agent",
    agentId: row.agent_id,
  }));
}

function resolveSqliteExtractionBytes(entries: SqliteSnapshotEntry[]): number {
  let totalBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
      throw new Error(`SQLite snapshot has an invalid archive size: ${entry.normalized}`);
    }
    if (entry.size === 0) {
      throw new Error(`SQLite snapshot is empty: ${entry.normalized}`);
    }
    totalBytes += entry.size ?? 0;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error("SQLite snapshot extraction size exceeds the supported integer range.");
    }
  }
  return totalBytes;
}

function assertSqliteExtractionBudget(params: {
  entries: SqliteSnapshotEntry[];
  tempRoot: string;
  extractedBytes?: number;
}): void {
  const totalBytes = resolveSqliteExtractionBytes(params.entries);
  if (totalBytes > MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES) {
    throw new Error(
      `SQLite snapshots require ${formatDiskSpaceBytes(totalBytes)} of extraction space; the verification limit is ${formatDiskSpaceBytes(MAX_SQLITE_SNAPSHOT_EXTRACT_BYTES)}.`,
    );
  }

  const remainingBytes = totalBytes - (params.extractedBytes ?? 0);
  const diskSpace = tryReadDiskSpace(params.tempRoot);
  if (
    diskSpace &&
    remainingBytes + SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES > diskSpace.availableBytes
  ) {
    throw new Error(
      `SQLite snapshots require ${formatDiskSpaceBytes(remainingBytes)} of extraction space, but only ${formatDiskSpaceBytes(diskSpace.availableBytes)} is available near ${params.tempRoot}; verification reserves ${formatDiskSpaceBytes(SQLITE_SNAPSHOT_FREE_SPACE_RESERVE_BYTES)} for the host.`,
    );
  }
}

function assertExpectedSqliteRole(
  database: DatabaseSync,
  archivePath: string,
  expectedRole: ExpectedSqliteRole,
): void {
  const schemaMetaTable = database
    .prepare("SELECT type FROM sqlite_schema WHERE name = 'schema_meta'")
    .get() as { type?: unknown } | undefined;
  if (schemaMetaTable?.type !== "table") {
    throw new Error(`SQLite snapshot ${archivePath} is missing the expected schema_meta table.`);
  }

  const metadata = database
    .prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { role?: unknown } | undefined;
  const actualRole = typeof metadata?.role === "string" ? metadata.role : "missing";
  if (actualRole !== expectedRole) {
    throw new Error(
      `SQLite snapshot ${archivePath} has role ${actualRole}; expected ${expectedRole}.`,
    );
  }
}

async function assertSqliteSnapshotFileShape(
  extractedPath: string,
  archivePath: string,
  expectedSize: number,
): Promise<void> {
  const header = Buffer.alloc(100);
  const handle = await fs.open(extractedPath, "r");
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (
      bytesRead !== header.byteLength ||
      header.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000"
    ) {
      throw new Error(`SQLite snapshot ${archivePath} has an invalid database header.`);
    }
  } finally {
    await handle.close();
  }

  const encodedPageSize = header.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const validPageSize = pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0;
  if (!validPageSize || expectedSize % pageSize !== 0) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }

  const changeCounter = header.readUInt32BE(24);
  const declaredPageCount = header.readUInt32BE(28);
  const versionValidFor = header.readUInt32BE(92);
  const hasAuthoritativePageCount = declaredPageCount !== 0 && changeCounter === versionValidFor;
  if (hasAuthoritativePageCount && declaredPageCount !== expectedSize / pageSize) {
    throw new Error(`SQLite snapshot ${archivePath} has an invalid page layout.`);
  }
}

async function verifySqliteSnapshots(params: {
  archivePath: string;
  entries: NormalizedArchiveEntry[];
  manifest: BackupManifest;
}): Promise<void> {
  const stateDir =
    params.manifest.paths?.stateDir ??
    params.manifest.assets.find((asset) => asset.kind === "state")?.sourcePath;
  if (!stateDir) {
    return;
  }
  const stateAssetRoot = buildBackupArchivePath(params.manifest.archiveRoot, stateDir);
  const portableStateRoot = resolvePortableArchivePathKey(stateAssetRoot);
  for (const entry of params.entries) {
    if (
      isArchivePathWithin(resolvePortableArchivePathKey(entry.normalized), portableStateRoot) &&
      !isArchivePathWithin(entry.normalized, stateAssetRoot)
    ) {
      throw new Error(`Backup contains a case-mangled state asset path: ${entry.normalized}`);
    }
  }
  const globalOwner: SqliteSnapshotOwner = {
    archivePath: path.posix.join(stateAssetRoot, "state/openclaw.sqlite"),
    role: "global",
  };
  const globalEntries = listSqliteSnapshotEntries(params.entries, [globalOwner]);
  if (globalEntries.length === 0) {
    return;
  }
  resolveCanonicalStateAssetRoot(params.manifest);
  const tempRoot = os.tmpdir();
  assertSqliteExtractionBudget({ entries: globalEntries, tempRoot });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-verify-sqlite-"));
  try {
    const batches = [globalEntries];
    const extractedEntries: SqliteSnapshotEntry[] = [];
    for (const sqliteEntries of batches) {
      const extractedBytes = resolveSqliteExtractionBytes(extractedEntries);
      extractedEntries.push(...sqliteEntries);
      if (extractedBytes > 0) {
        assertSqliteExtractionBudget({ entries: extractedEntries, tempRoot, extractedBytes });
      }
      const sqliteEntriesByRawPath = new Map(sqliteEntries.map((entry) => [entry.raw, entry]));
      await tar.x({
        file: params.archivePath,
        gzip: true,
        maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
        cwd: tempDir,
        strict: true,
        preserveOwner: false,
        filter: (entryPath, archiveEntry) => {
          const expected = sqliteEntriesByRawPath.get(entryPath);
          if (!expected) {
            return false;
          }
          if (archiveEntry.size !== expected.size) {
            throw new Error(`SQLite snapshot size changed during verification: ${entryPath}`);
          }
          return true;
        },
      });

      for (const entry of sqliteEntries) {
        const extractedPath = path.join(tempDir, ...entry.normalized.split("/"));
        const extractedStat = await fs.lstat(extractedPath);
        if (!extractedStat.isFile()) {
          throw new Error(`Extracted SQLite snapshot is not a regular file: ${entry.normalized}`);
        }
        if (extractedStat.size !== entry.size) {
          throw new Error(
            `Extracted SQLite snapshot size does not match archive: ${entry.normalized}`,
          );
        }

        let database: DatabaseSync | undefined;
        try {
          await assertSqliteSnapshotFileShape(extractedPath, entry.normalized, extractedStat.size);
          database = openNodeSqliteDatabase(extractedPath, {
            allowExtension: true,
            readOnly: true,
          });
          database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
          await loadSqliteVecExtension({ db: database });
          assertSqliteIntegrity(database, entry.normalized);
          if (entry.role === "agent") {
            assertOpenClawAgentDatabaseOwner(database, {
              agentId: entry.agentId,
              pathname: entry.normalized,
            });
          } else {
            assertExpectedSqliteRole(database, entry.normalized, entry.role);
          }
          if (entry.role === "global") {
            const agentOwners = readArchivedAgentDatabaseOwners(
              database,
              params.manifest,
              stateDir,
            );
            const ownerByPath = new Map<string, SqliteSnapshotOwner>([
              [resolvePortableArchivePathKey(globalOwner.archivePath), globalOwner],
            ]);
            for (const owner of agentOwners) {
              const ownerKey = resolvePortableArchivePathKey(owner.archivePath);
              const previous = ownerByPath.get(ownerKey);
              if (
                previous &&
                (previous.role !== "agent" ||
                  owner.role !== "agent" ||
                  previous.agentId !== owner.agentId ||
                  previous.archivePath !== owner.archivePath)
              ) {
                throw new Error(
                  `SQLite snapshot has conflicting registered owners: ${owner.archivePath}`,
                );
              }
              ownerByPath.set(ownerKey, owner);
            }
            const agentEntries = listSqliteSnapshotEntries(params.entries, agentOwners);
            if (agentEntries.length > 0) {
              batches.push(agentEntries);
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Backup SQLite snapshot failed verification: ${entry.normalized}. ${message}`,
            { cause: err },
          );
        } finally {
          database?.close();
        }
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyResolvedBackupArchive(archivePath: string): Promise<PreparedBackupArchive> {
  let archiveStat;
  try {
    archiveStat = await fs.stat(archivePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(
        "Archive does not exist. Check the path and run `openclaw backup verify <archive>` again.",
        { cause: error },
      );
    }
    throw new Error(
      `Archive could not be inspected. ${formatErrorMessage(error)} Check the path and file permissions, then try again.`,
      { cause: error },
    );
  }
  if (!archiveStat.isFile()) {
    throw new Error(
      "Archive must be a regular file. Choose a backup archive created by `openclaw backup create` and try again.",
    );
  }

  const listing = await listArchiveEntries(archivePath).catch((error: unknown) => {
    throw new Error(
      `Archive could not be read or parsed. ${formatErrorMessage(error)} Check the file permissions and archive integrity, then try again.`,
    );
  });
  if (listing.invalidReason) {
    throw new Error(
      `Archive is not a valid OpenClaw backup. ${listing.invalidReason.replace(/[.!?]*$/u, ".")} Choose another archive or create a new one with \`openclaw backup create\`.`,
    );
  }
  const rawEntries = listing.entries;

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.type ? { type: entry.type } : {}),
  }));
  const symbolicLinks = rawEntries
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => ({ entryPath: entry.path, linkpath: entry.linkpath }));
  const rawEntryPaths = new Map<string, string>();
  let duplicateEntryPath: string | undefined;
  // Keep the first duplicate for validation below; manifest-count errors still win.
  for (const entry of entries) {
    if (rawEntryPaths.has(entry.normalized)) {
      duplicateEntryPath ??= entry.normalized;
    }
    rawEntryPaths.set(entry.normalized, entry.raw);
  }
  const normalizedEntrySet = new Set(rawEntryPaths.keys());

  const manifestMatches = entries.filter((entry) => isRootBackupManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }
  const portablePathCollision = findPortableArchiveEntryPathCollision(entries);
  if (portablePathCollision) {
    throw new Error(
      `Archive contains a portable path collision: ${portablePathCollision.first} and ${portablePathCollision.second}`,
    );
  }
  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseBackupManifest(manifestRaw);
  verifyBackupManifestEntries(manifest, normalizedEntrySet);
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const hardlinkTargets = new Map<string, string>();
  for (const entry of rawEntries) {
    if (entry.type === "Link") {
      const target = normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.path}`,
      );
      // Older backups omit the archive root. Resolve once, retaining the actual
      // entry spelling: normalization is a lookup key, not a filename rewrite.
      const resolved = isArchivePathWithin(target, archiveRoot)
        ? target
        : path.posix.join(archiveRoot, target);
      const rawTarget = rawEntryPaths.get(resolved);
      if (!rawTarget) {
        throw new Error(
          `Archive hardlink target is missing from archive entries: ${entry.path} -> ${resolved}`,
        );
      }
      hardlinkTargets.set(entry.path, rawTarget);
    }
  }
  const preparedSymbolicLinks: BackupSymbolicLink[] = [];
  const externalSymbolicLinks: BackupSymbolicLink[] = [];
  const symbolicLinkPaths = new Set(
    symbolicLinks.map(({ entryPath }) =>
      resolvePortableArchivePathKey(normalizeArchivePath(entryPath, "Archive symbolic link path")),
    ),
  );
  for (const entry of entries) {
    for (
      let parent = path.posix.dirname(entry.normalized);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      if (symbolicLinkPaths.has(resolvePortableArchivePathKey(parent))) {
        throw new Error(`Archive entry is beneath a symbolic link: ${entry.raw}`);
      }
    }
  }
  const state =
    manifest.assets.find((asset) => asset.kind === "state") ??
    (manifest.paths?.stateDir
      ? {
          sourcePath: manifest.paths.stateDir,
          archivePath: buildBackupArchivePath(manifest.archiveRoot, manifest.paths.stateDir),
        }
      : undefined);
  for (const link of symbolicLinks) {
    const { external, ...record } = recordArchiveSymbolicLink({
      ...link,
      archiveRoot: manifest.archiveRoot,
      platform: manifest.platform,
      state,
      hasExternalLinkReport: manifest.externalSymbolicLinks !== undefined,
      assets: manifest.assets,
    });
    preparedSymbolicLinks.push(record);
    if (external) {
      externalSymbolicLinks.push(record);
    }
  }
  const reportedLinks = new Map(
    (manifest.externalSymbolicLinks ?? []).map(({ entryPath, linkpath }) => [entryPath, linkpath]),
  );
  if (
    manifest.externalSymbolicLinks !== undefined &&
    (reportedLinks.size !== externalSymbolicLinks.length ||
      externalSymbolicLinks.some(
        ({ entryPath, linkpath }) => reportedLinks.get(entryPath) !== linkpath,
      ))
  ) {
    throw new Error("Backup manifest external symbolic links do not match archive entries.");
  }
  await verifySqliteSnapshots({ archivePath, entries, manifest });

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
    symlinkCount: symbolicLinks.length,
    ...(externalSymbolicLinks.length ? { externalSymbolicLinks } : {}),
  };

  return { result, hardlinkTargets, symbolicLinks: preparedSymbolicLinks };
}

/** Verify an archive and prepare the exact hardlink targets needed by extraction. */
export async function prepareBackupArchive(archive: string): Promise<PreparedBackupArchive> {
  const archivePath = resolveUserPath(archive);
  return await verifyResolvedBackupArchive(archivePath).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : formatErrorMessage(error);
    throw new Error(`Backup archive verification failed: ${archivePath}. ${detail}`);
  });
}

/** Verify a backup archive without exposing extraction metadata in CLI output. */
export async function verifyBackupArchive(archive: string): Promise<BackupVerifyResult> {
  return (await prepareBackupArchive(archive)).result;
}

/** Verify a backup archive, including snapshot shape and canonical SQLite integrity checks. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const result = await verifyBackupArchive(opts.archive);

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
