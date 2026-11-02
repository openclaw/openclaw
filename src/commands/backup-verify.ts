import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  recordArchiveSymbolicLink,
  resolvePortableArchivePathKey,
  findPortableArchiveEntryPathCollision,
  type BackupSymbolicLink,
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
  buildBackupArchivePath,
} from "../infra/backup-archive-path-policy.js";
import { readEngineAnchor } from "../infra/database-engine/open.js";
import { readEngineAnchorIdentity } from "../infra/database-engine/physical-store.js";
import { loadSqliteVecExtension } from "../infra/database-engine/sqlite-vec.js";
import { sha256File } from "../infra/directory-durability.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { configureSqliteReadOnlyPragmas } from "../infra/sqlite-wal.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry.read.js";
import { resolveBackupRecoveryConfig } from "./backup-recovery-config.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import { resolveBackupArchivePath } from "./backup-shared.js";
import {
  type BackupManifest,
  type NormalizedArchiveEntry,
  isRegularArchiveFile,
  isRootBackupManifestEntry,
  parseBackupManifest,
  resolvePostgresRestoreEntries,
  verifyBackupManifestEntries,
  verifyBackupSqliteCoverage,
} from "./backup-verify-manifest.js";
import {
  assertSqliteSnapshotFileShape,
  prepareDatabaseArtifacts,
  BackupArchiveSpool,
  listBackupArchiveEntries,
  resolveExtractionBytes,
  assertSnapshotExtractionBudget,
} from "./backup-verify-spool.js";

type BackupVerifyResult = Awaited<ReturnType<typeof verifyBackupArchive>>;

type SqliteSnapshotIdentity = { role: "global" } | { role: "agent"; agentId: string };

type SqliteSnapshotEntry = NormalizedArchiveEntry & SqliteSnapshotOwner;

function formatResult(result: BackupVerifyResult): string {
  return [
    terminalText`Backup archive OK: ${result.archivePath}`,
    terminalText`Archive root: ${result.archiveRoot}`,
    terminalText`Created at: ${result.createdAt}`,
    terminalText`Runtime version: ${result.runtimeVersion}`,
    terminalText`Assets verified: ${result.assetCount}`,
    terminalText`Archive entries scanned: ${result.entryCount}`,
    terminalText`Symbolic links checked: ${result.symlinkCount}`,
    result.sqliteInventoryVerified
      ? "SQLite database inventory verified."
      : "SQLite database coverage unknown: this legacy archive has no database inventory.",
    ...(result.warnings ?? []).map((warning) => terminalText`${warning}`),
  ].join("\n");
}

function assertCanonicalStateAssetRoot(manifest: BackupManifest): void {
  const stateAssets = manifest.assets.filter((asset) => asset.kind === "state");
  const stateAsset = stateAssets[0];
  if (!stateAsset) {
    return;
  }
  if (stateAssets.length !== 1) {
    throw new Error(
      `Backup manifest must contain at most one state asset; found ${stateAssets.length}.`,
    );
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
}

type SqliteSnapshotOwner = { archivePath: string } & SqliteSnapshotIdentity;

function listSqliteSnapshotEntries(
  entries: NormalizedArchiveEntry[],
  owners: SqliteSnapshotOwner[],
  postgresAnchors: ReadonlySet<string>,
  companionAnchors: ReadonlySet<string>,
): SqliteSnapshotEntry[] {
  const ownersByPath = new Map(
    owners.map((owner) => [resolvePortableArchivePathKey(owner.archivePath), owner]),
  );
  const snapshots: SqliteSnapshotEntry[] = [];
  const byPath = new Map(entries.map((entry) => [entry.normalized, entry]));
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
      throw new Error(
        `Backup contains a SQLite path with incorrect letter casing: ${entry.normalized}`,
      );
    }
    if (!isRegularArchiveFile(entry.type)) {
      throw new Error(`SQLite snapshot must be a regular archive file: ${entry.normalized}`);
    }
    if (companionAnchors.has(entry.normalized)) {
      continue;
    }
    const exportPath = `${entry.normalized}.postgres`;
    const image = postgresAnchors.has(entry.normalized)
      ? byPath.get(`${exportPath}/database.sqlite`)
      : entry;
    if (!image || !isRegularArchiveFile(image.type)) {
      throw new Error(`PostgreSQL snapshot is missing its portable database: ${exportPath}`);
    }
    snapshots.push({ ...image, ...owner });
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

function assertExpectedSqliteRole(
  database: DatabaseSync,
  archivePath: string,
  expectedRole: SqliteSnapshotIdentity["role"],
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

async function verifyPostgresSnapshots(
  archivePath: string,
  entries: NormalizedArchiveEntry[],
  captures: ReturnType<typeof resolvePostgresRestoreEntries>["captures"],
  spool: BackupArchiveSpool,
): Promise<void> {
  if (!captures.length) {
    return;
  }
  const paths = new Set(
    captures.flatMap(({ directoryPath, anchorPath }) => [
      anchorPath,
      ...["manifest.json", "anchor.sqlite", "database.sqlite", ".pending"].map(
        (name) => `${directoryPath}/${name}`,
      ),
    ]),
  );
  const artifacts = entries.filter((entry) => paths.has(entry.normalized));
  await assertSnapshotExtractionBudget({
    entries: artifacts,
    tempRoot: spool.tempRoot,
    postgres: true,
    spool,
  });
  const tempDir = await prepareDatabaseArtifacts(archivePath, spool, artifacts);
  const { readBackupEngineImage, verifyMatchedPostgresBackup } =
    await import("../snapshot/database-backup.js");
  for (const { directoryPath, anchorPath, manifestSha256 } of captures) {
    const manifestPath = path.join(tempDir, directoryPath, "manifest.json");
    if (manifestSha256 && (await sha256File(manifestPath)).digest !== manifestSha256) {
      throw new Error(`PostgreSQL capsule does not match its capture inventory: ${directoryPath}`);
    }
    const anchor = readBackupEngineImage(path.join(tempDir, anchorPath), anchorPath);
    if (anchor.engine !== "postgres") {
      throw new Error(`PostgreSQL backup has an invalid outer anchor: ${anchorPath}`);
    }
    await verifyMatchedPostgresBackup(path.join(tempDir, directoryPath), "user-backup", anchor);
  }
}

async function verifyLocalCompanionAnchors(
  archivePath: string,
  entries: NormalizedArchiveEntry[],
  manifest: BackupManifest,
  spool: BackupArchiveSpool,
): Promise<SqliteSnapshotOwner[]> {
  if (manifest.profile !== "local-companion") {
    return [];
  }
  // A companion must not silently preserve undeclared exports that look recoverable.
  if (
    entries.some((entry) =>
      entry.normalized.split("/").some((part) => part.toLowerCase().endsWith(".postgres")),
    )
  ) {
    throw new Error("Local-companion checkpoint contains an undeclared PostgreSQL export.");
  }
  const anchors = (manifest.postgresAnchors ?? []).map((anchor) => ({
    sourcePath: anchor.sourcePath,
    storeId: anchor.storeId,
    namespace: anchor.namespace,
    archivePath: buildBackupArchivePath(manifest.archiveRoot, anchor.sourcePath),
  }));
  const byPath = new Map(entries.map((entry) => [entry.normalized, entry]));
  const portablePaths = new Set(
    entries.map((entry) => resolvePortableArchivePathKey(entry.normalized)),
  );
  const artifacts = anchors.map((anchor) => {
    const entry = byPath.get(anchor.archivePath);
    if (
      !entry ||
      !isRegularArchiveFile(entry.type) ||
      SQLITE_SIDECAR_SUFFIXES.some((suffix) =>
        portablePaths.has(resolvePortableArchivePathKey(`${anchor.archivePath}${suffix}`)),
      )
    ) {
      throw new Error(
        `Local-companion anchor is missing, invalid, or has sidecars: ${anchor.archivePath}`,
      );
    }
    return entry;
  });
  if (!artifacts.length) {
    return [];
  }
  assertCanonicalStateAssetRoot(manifest);
  await assertSnapshotExtractionBudget({ entries: artifacts, tempRoot: spool.tempRoot, spool });
  const tempDir = await prepareDatabaseArtifacts(archivePath, spool, artifacts);
  const verified: SqliteSnapshotOwner[] = [];
  for (const [index, anchor] of anchors.entries()) {
    const imagePath = path.join(tempDir, anchor.archivePath);
    await assertSqliteSnapshotFileShape(imagePath, anchor.archivePath, artifacts[index]!.size!);
    using database = openNodeSqliteDatabase(imagePath, { readOnly: true });
    configureSqliteReadOnlyPragmas(database);
    assertSqliteIntegrity(database, anchor.archivePath);
    const identity = readEngineAnchorIdentity(database, anchor.archivePath);
    if (
      identity.engine !== "postgres" ||
      identity.storeId !== anchor.storeId ||
      identity.namespace !== anchor.namespace
    ) {
      throw new Error(`Local-companion PostgreSQL identity mismatch: ${anchor.archivePath}`);
    }
    const owner = manifest.sqliteSnapshots?.find(
      (snapshot) => snapshot.sourcePath === anchor.sourcePath,
    );
    if (owner) {
      verified.push({ ...owner, archivePath: anchor.archivePath });
    }
  }
  return verified;
}

async function verifySqliteSnapshots(params: {
  archivePath: string;
  entries: NormalizedArchiveEntry[];
  manifest: BackupManifest;
  postgresAnchors: ReadonlySet<string>;
  companionAnchors: ReadonlySet<string>;
  spool: BackupArchiveSpool;
}): Promise<SqliteSnapshotOwner[]> {
  const verifiedOwners: SqliteSnapshotOwner[] = [];
  const stateDir =
    params.manifest.paths?.stateDir ??
    params.manifest.assets.find((asset) => asset.kind === "state")?.sourcePath;
  if (!stateDir) {
    return verifiedOwners;
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
  const declaredOwners: SqliteSnapshotOwner[] = [
    globalOwner,
    ...(params.manifest.sqliteSnapshots ?? [])
      .filter((snapshot) => snapshot.role === "agent")
      .map(({ sourcePath, role, agentId }) => ({
        role,
        agentId,
        archivePath: buildBackupArchivePath(params.manifest.archiveRoot, sourcePath),
      })),
  ];
  const initialEntries = listSqliteSnapshotEntries(
    params.entries,
    declaredOwners,
    params.postgresAnchors,
    params.companionAnchors,
  );
  if (initialEntries.length === 0) {
    return verifiedOwners;
  }
  assertCanonicalStateAssetRoot(params.manifest);
  const tempRoot = params.spool.tempRoot;
  const batches = [initialEntries];
  const extractedEntries: SqliteSnapshotEntry[] = [];
  for (const sqliteEntries of batches) {
    extractedEntries.push(...sqliteEntries);
    await assertSnapshotExtractionBudget({
      entries: extractedEntries,
      tempRoot,
      spool: params.spool,
    });
    const tempDir = await prepareDatabaseArtifacts(params.archivePath, params.spool, sqliteEntries);

    for (const entry of sqliteEntries) {
      const extractedPath = path.join(tempDir, ...entry.normalized.split("/"));

      let database: DatabaseSync | undefined;
      try {
        await assertSqliteSnapshotFileShape(extractedPath, entry.normalized, entry.size!);
        database = openNodeSqliteDatabase(extractedPath, {
          allowExtension: true,
          readOnly: true,
        });
        if (readEngineAnchor(database)) {
          throw new Error(
            "PostgreSQL anchor has no owned matched capsule. Re-run backup with this version on the source installation.",
          );
        }
        configureSqliteReadOnlyPragmas(database);
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
        verifiedOwners.push({ ...entry });
        if (entry.role === "global") {
          const agentOwners = readArchivedAgentDatabaseOwners(database, params.manifest, stateDir);
          const ownerByPath = new Map<string, SqliteSnapshotOwner>(
            declaredOwners.map((owner) => [
              resolvePortableArchivePathKey(owner.archivePath),
              owner,
            ]),
          );
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
          const agentEntries = listSqliteSnapshotEntries(
            params.entries,
            agentOwners,
            params.postgresAnchors,
            params.companionAnchors,
          ).filter(
            (candidate) => !extractedEntries.some((extracted) => extracted.raw === candidate.raw),
          );
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
  return verifiedOwners;
}

async function verifyResolvedBackupArchive(
  archivePath: string,
  requiredSnapshots: readonly BackupSqliteSnapshotFact[],
) {
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

  await using spool = new BackupArchiveSpool();
  const listing = await listBackupArchiveEntries(archivePath, (entry, normalized) =>
    spool.capture(entry, normalized),
  ).catch((error: unknown) => {
    throw new Error(
      `Archive could not be read or parsed. ${formatErrorMessage(error)} Check the file permissions and archive integrity, then try again.`,
    );
  });
  if (listing.invalidReason) {
    throw new Error(
      `Archive is not a valid OpenClaw backup. ${listing.invalidReason.replace(/[.!?]*$/u, ".")} Choose another archive or create a new one with \`openclaw backup create\`.`,
    );
  }
  if (listing.pathError) {
    throw listing.pathError;
  }
  const entries = listing.entries;
  const symbolicLinks = entries
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => ({ entryPath: entry.raw, linkpath: entry.linkpath }));
  const entriesByPath = new Map<string, NormalizedArchiveEntry>();
  let duplicateEntryPath: string | undefined;
  // Keep the first duplicate for validation below; manifest-count errors still win.
  for (const entry of entries) {
    if (entriesByPath.has(entry.normalized)) {
      duplicateEntryPath ??= entry.normalized;
    }
    entriesByPath.set(entry.normalized, entry);
  }
  const normalizedEntrySet = new Set(entriesByPath.keys());

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
  if (!listing.manifestContent) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await listing.manifestContent;
  if (manifestRaw instanceof Error) {
    throw manifestRaw;
  }
  const manifest = parseBackupManifest(manifestRaw);
  verifyBackupManifestEntries(manifest, normalizedEntrySet);
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const hardlinkTargets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "Link") {
      const target = normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.raw}`,
      );
      // Older backups omit the archive root. Resolve once, retaining the actual
      // entry spelling: normalization is a lookup key, not a filename rewrite.
      const resolved = isArchivePathWithin(target, archiveRoot)
        ? target
        : path.posix.join(archiveRoot, target);
      let rawTarget = entriesByPath.get(resolved)?.raw;
      if (!rawTarget && !isArchivePathWithin(target, archiveRoot)) {
        // Historical writers remapped member names but retained cwd-relative link targets.
        // Only an exact, unambiguous regular-file match can recover that lost prefix.
        const candidates = new Set<string>();
        for (
          let parent = path.posix.dirname(entry.normalized);
          isArchivePathWithin(parent, archiveRoot);
          parent = path.posix.dirname(parent)
        ) {
          const candidate = entriesByPath.get(path.posix.join(parent, target));
          if (candidate && isRegularArchiveFile(candidate.type)) {
            candidates.add(candidate.raw);
          }
          if (parent === archiveRoot) {
            break;
          }
        }
        if (candidates.size > 1) {
          throw new Error(`Archive hardlink target is ambiguous: ${entry.raw} -> ${target}`);
        }
        rawTarget = candidates.values().next().value;
      }
      if (!rawTarget) {
        throw new Error(
          `Archive hardlink target is missing from archive entries: ${entry.raw} -> ${resolved}`,
        );
      }
      hardlinkTargets.set(entry.raw, rawTarget);
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
  const { captures: databaseRestoreCandidates, warnings } = resolvePostgresRestoreEntries(
    entries,
    manifest,
  );
  await verifyPostgresSnapshots(archivePath, entries, databaseRestoreCandidates, spool);
  const companionOwners = await verifyLocalCompanionAnchors(archivePath, entries, manifest, spool);
  const verifiedSnapshots = await verifySqliteSnapshots({
    archivePath,
    entries,
    manifest,
    spool,
    postgresAnchors: new Set(databaseRestoreCandidates.map(({ anchorPath }) => anchorPath)),
    companionAnchors: new Set(
      (manifest.postgresAnchors ?? []).map(({ sourcePath }) =>
        buildBackupArchivePath(manifest.archiveRoot, sourcePath),
      ),
    ),
  });
  verifyBackupSqliteCoverage(manifest, requiredSnapshots, [
    ...verifiedSnapshots,
    ...companionOwners,
  ]);
  if (manifest.profile === "local-companion") {
    warnings.push(
      "Local-companion checkpoint contains no PostgreSQL rows and is not disaster recovery; restore keeps the same PostgreSQL stores and namespaces.",
    );
  }

  const result = {
    ok: true as const,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: entries.length,
    symlinkCount: symbolicLinks.length,
    sqliteInventoryVerified: manifest.sqliteSnapshots !== undefined,
    ...(manifest.profile ? { profile: manifest.profile } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(externalSymbolicLinks.length ? { externalSymbolicLinks } : {}),
  };

  return {
    result,
    ...resolveBackupRecoveryConfig(manifest, entries, preparedSymbolicLinks),
    manifest,
    hardlinkTargets,
    symbolicLinks: preparedSymbolicLinks,
    regularFileExtractionBytes: resolveExtractionBytes(entries),
    databaseRestoreCandidates,
  };
}

/** Verify an archive and prepare the exact hardlink targets needed by extraction. */
export async function prepareBackupArchive(
  archive: string,
  requiredSnapshots: readonly BackupSqliteSnapshotFact[] = [],
) {
  const archivePath = resolveBackupArchivePath(archive, "<archive>");
  return await verifyResolvedBackupArchive(archivePath, requiredSnapshots).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : formatErrorMessage(error);
      throw new Error(`Backup archive verification failed: ${archivePath}. ${detail}`);
    },
  );
}

/** Verify a backup archive without exposing extraction metadata in CLI output. */
export async function verifyBackupArchive(
  archive: string,
  requiredSnapshots: readonly BackupSqliteSnapshotFact[] = [],
) {
  return (await prepareBackupArchive(archive, requiredSnapshots)).result;
}

/** Verify a backup archive, including snapshot shape and canonical SQLite integrity checks. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: { archive: string; json?: boolean },
): Promise<BackupVerifyResult> {
  const result = await verifyBackupArchive(opts.archive);

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
