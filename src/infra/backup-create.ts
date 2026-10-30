// Creates backup archives while filtering volatile runtime state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { resolveDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  sealBackupResourceInventory,
  describeCapturedBackupSqliteSnapshots,
  type BackupAgentRoot,
  type BackupResourcePlan,
  type BackupSqliteSnapshotFact,
} from "../commands/backup-resource-inventory.js";
import {
  buildBackupArchiveBasename,
  buildBackupArchiveRoot,
  canonicalizePathForContainment,
  type BackupAsset,
  resolveBackupPlanFromDisk,
  resolveBackupArchivePath,
} from "../commands/backup-shared.js";
import { encodeBackupManifest, type BackupManifest } from "../commands/backup-verify-manifest.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { runOfflineDatabaseBackup } from "../snapshot/database-backup.js";
import { resolveHomeDir } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  recordArchiveSymbolicLink,
  type BackupSymbolicLink,
  buildBackupArchivePath,
} from "./backup-archive-path-policy.js";
import {
  cleanupBackupArchivePublication,
  createBackupArchivePublication,
  publishPreparedBackupArchive,
  type BackupArchivePublication,
} from "./backup-archive-publication.js";
import {
  hasLegacyAuditBackupSources,
  isLegacyAuditMigrationBackupPath,
} from "./backup-audit-paths.js";
import { stageBackupConfigCapture } from "./backup-config-capture.js";
import {
  appendBackupManifest,
  removePreparedBackupArchive,
  writeArchiveStreamToFile,
} from "./backup-create-stream.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
} from "./backup-scratch.js";
import {
  classifyBackupSqliteSource,
  createBackupSqliteSnapshotPlan,
} from "./backup-sqlite-snapshot.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import { walkBackupTar } from "./backup-tar-walk.js";
import { isErrno } from "./errors.js";
import { safeStat } from "./path-existence.js";
import {
  createLegacyAuditBackupCapture,
  legacyAuditBackupCapturesMatch,
  LegacyAuditBackupStateChangedError,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";
import { withLegacyAuditMigrationLease } from "./state-migrations.audit-coordination.js";
import { isUpdateCapturePath } from "./update-capture-paths.js";

const loadTarRuntime = createLazyRuntimeModule(() => import("tar"));

export type BackupCreateOptions = {
  /** Internal lifecycle cancellation for backup preparation, not admitted repairs. */
  signal?: AbortSignal;
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  /**
   * Optional info logger invoked for non-fatal backup events such as tar
   * retry notices or volatile-file skip counts. When omitted, events are
   * silent aside from the final result.
   */
  log?: (message: string) => void;
  /** Internal consumers bind later effects to the canonical images actually captured. */
  onSqliteSnapshots?: (facts: readonly BackupSqliteSnapshotFact[]) => void;
};

type BackupManifestAgentRoot = Pick<BackupAgentRoot, "agentId" | "sourcePath">;

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  assets: BackupAsset[];
  agentRoots?: readonly BackupManifestAgentRoot[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    displayPath: string;
    reason: string;
    coveredBy?: string;
  }>;
  /**
   * Count of files the archiver actively skipped because they matched the
   * known-volatile filter (live sessions, cron logs, queues, sockets, pid/tmp).
   * Populated on real writes only; dry runs report 0.
   */
  skippedVolatileCount: number;
  externalSymbolicLinks?: BackupSymbolicLink[];
  warnings?: string[];
};

async function resolveOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: BackupAsset[];
  stateDir: string;
}): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output;
  if (!rawOutput?.trim()) {
    const cwd = path.resolve(process.cwd());
    const canonicalCwd = await fs.realpath(cwd).catch(() => cwd);
    const cwdInsideSource = params.includedAssets.some((asset) =>
      isPathInside(asset.sourcePath, canonicalCwd),
    );
    const defaultDir = cwdInsideSource ? (resolveHomeDir() ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveBackupArchivePath(rawOutput, "--output");
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  if ((await safeStat(resolved))?.isDirectory()) {
    return path.join(resolved, basename);
  }

  return resolved;
}

type BackupOutputFailurePhase = "parent" | "publication" | "write";

function formatBackupOutputFailure(
  error: unknown,
  outputPath: string,
  phase: BackupOutputFailurePhase,
  ownedRoot?: string,
): unknown {
  const cause = phase === "write" && error instanceof Error ? error.cause : undefined;
  const filesystemError = isErrno(error) ? error : isErrno(cause) ? cause : null;
  if (!filesystemError) {
    return error;
  }
  if (ownedRoot) {
    const failedPath = filesystemError.path;
    if (typeof failedPath !== "string" || !isPathInside(ownedRoot, path.resolve(failedPath))) {
      return error;
    }
  }

  const outputParent = path.dirname(outputPath);
  const retry = "run `openclaw backup create --output <archive>` again.";
  let detail: string;
  switch (filesystemError.code) {
    case "ENOENT":
      detail = `Backup output directory could not be created: ${outputParent}. Check the path and ${retry}`;
      break;
    case "EACCES":
    case "EPERM":
    case "EROFS":
      detail = `Backup output directory is not writable: ${outputParent}. Check the path and directory permissions, then ${retry}`;
      break;
    case "EEXIST":
    case "ENOTDIR":
      if (phase !== "parent") {
        return error;
      }
      detail = `Backup output parent is not a directory: ${outputParent}. Choose a directory path and ${retry}`;
      break;
    case "ENOSPC":
      detail = `The destination does not have enough free space: ${outputParent}. Free up disk space and ${retry}`;
      break;
    case "EDQUOT":
      detail = `The destination storage quota is exhausted: ${outputParent}. Free up space or choose another path, then ${retry}`;
      break;
    default:
      detail = `The output path could not be prepared: ${outputParent}. Check the path and filesystem, then ${retry}`;
  }
  return new Error(`Backup archive creation failed: ${outputPath}. ${detail}`, { cause: error });
}

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw formatBackupOutputFailure(error, outputPath, "parent");
  }
}

async function prepareBackupOutputParent(outputPath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
  } catch (error) {
    throw formatBackupOutputFailure(error, outputPath, "parent");
  }
}

// Keep staged config and database snapshots outside the tree being archived.
export async function chooseBackupTempRoot(params: {
  assets: readonly BackupAsset[];
  outputPath?: string;
}): Promise<string> {
  const systemTmp = os.tmpdir();
  const canonicalSystemTmp = await canonicalizePathForContainment(systemTmp);
  const overlapping = params.assets.find((asset) =>
    isPathInside(asset.sourcePath, canonicalSystemTmp),
  );
  if (!overlapping) {
    return systemTmp;
  }

  // Fallback: the directory holding the output archive. The earlier
  // output-containment check guarantees `outputPath` is outside every asset,
  // so its parent is too. The caller must already have write access there to
  // write the archive itself, so this stays within the existing sandbox.
  // Without an output path (offsite uploads stage into scratch), fall back to
  // the parent of the source that contains the system temp dir, e.g. when the
  // Gateway runs jobs with TMPDIR=~/.openclaw/tmp.
  const fallback = params.outputPath
    ? path.dirname(params.outputPath)
    : path.dirname(overlapping.sourcePath);
  const canonicalFallback = await canonicalizePathForContainment(fallback);
  const fallbackInsideAsset = params.assets.find((asset) =>
    isPathInside(asset.sourcePath, canonicalFallback),
  );
  if (fallbackInsideAsset) {
    throw new Error(
      `Backup temp root cannot be placed outside every source path: ${systemTmp} and ${fallback} both overlap ${fallbackInsideAsset.sourcePath}.`,
    );
  }
  return fallback;
}

function buildManifest(
  result: BackupCreateResult,
  plan: Awaited<ReturnType<typeof resolveBackupPlanFromDisk>>,
): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: result.createdAt,
    archiveRoot: result.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: result.includeWorkspace,
      onlyConfig: result.onlyConfig,
    },
    paths: {
      stateDir: plan.resources.stateDir,
      configPath: plan.configPath,
      ...(plan.configCapture?.files[0]
        ? { configSourcePath: plan.configCapture.files[0].canonicalPath }
        : {}),
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
      ...(result.agentRoots ? { agentRoots: [...result.agentRoots] } : {}),
    },
    assets: result.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    skipped: result.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
}

const MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS = 3;

type ConsistentStateSnapshotPlan = {
  legacyAuditSnapshots: LegacyAuditBackupSnapshot[];
  stateSqliteBackup: Awaited<ReturnType<typeof createBackupSqliteSnapshotPlan>>;
};

async function createConsistentStateSnapshotPlan(params: {
  resources: BackupResourcePlan;
  stateDir?: string;
  tempDir: string;
  onlyConfig: boolean;
}): Promise<ConsistentStateSnapshotPlan> {
  const captureSqlite = (
    tempDir: string,
    audit?: Awaited<ReturnType<typeof createLegacyAuditBackupCapture>>,
  ) =>
    createBackupSqliteSnapshotPlan({
      resources: params.resources,
      tempDir,
      legacyAuditSnapshots: audit?.snapshots ?? [],
      ...(audit ? { legacyAuditDatabaseWitness: audit.databaseWitness } : {}),
    });
  if (params.onlyConfig || !params.stateDir) {
    return {
      legacyAuditSnapshots: [],
      stateSqliteBackup: params.onlyConfig
        ? {
            inventory: sealBackupResourceInventory(params.resources, []),
            snapshots: [],
            postgresSnapshots: [],
            discoveredSourcePaths: new Set<string>(),
          }
        : await captureSqlite(params.tempDir),
    };
  }

  const stateDir = params.stateDir;
  if (!(await hasLegacyAuditBackupSources(stateDir))) {
    const fastAttemptDir = path.join(params.tempDir, "state-snapshot-no-legacy");
    await fs.mkdir(fastAttemptDir, { recursive: true });
    const stateSqliteBackup = await captureSqlite(fastAttemptDir);
    if (!(await hasLegacyAuditBackupSources(stateDir))) {
      return { legacyAuditSnapshots: [], stateSqliteBackup };
    }
    await fs.rm(fastAttemptDir, { recursive: true, force: true });
  }

  let lastStateChangeMessage: string | undefined;
  for (let attempt = 0; attempt < MAX_LEGACY_AUDIT_CAPTURE_ATTEMPTS; attempt += 1) {
    const attemptDir = path.join(params.tempDir, `state-snapshot-attempt-${attempt + 1}`);
    const verificationDir = path.join(attemptDir, "legacy-verification");
    await fs.mkdir(attemptDir, { recursive: true });
    try {
      const firstCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: attemptDir }),
      );
      const stateSqliteBackup = await captureSqlite(attemptDir, firstCapture);
      await fs.mkdir(verificationDir, { recursive: true });
      const secondCapture = await withLegacyAuditMigrationLease(stateDir, () =>
        createLegacyAuditBackupCapture({ stateDir, tempDir: verificationDir }),
      );
      if (!legacyAuditBackupCapturesMatch(firstCapture, secondCapture)) {
        throw new LegacyAuditBackupStateChangedError();
      }
      await fs.rm(verificationDir, { recursive: true, force: true });
      return { legacyAuditSnapshots: firstCapture.snapshots, stateSqliteBackup };
    } catch (error) {
      await fs.rm(attemptDir, { recursive: true, force: true });
      if (!(error instanceof LegacyAuditBackupStateChangedError)) {
        throw error;
      }
      lastStateChangeMessage = error.message;
    }
  }
  throw new LegacyAuditBackupStateChangedError(
    `${lastStateChangeMessage ?? "Legacy audit state changed while backup was capturing it"}; retry backup after legacy audit migration settles`,
  );
}

export async function createBackupArchive(
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  return await withCommandProcessScope(() => createBackupArchiveInScope(opts), opts.signal);
}

async function createBackupArchiveInScope(
  opts: BackupCreateOptions,
  preparedPlan?: Awaited<ReturnType<typeof resolveBackupPlanFromDisk>>,
): Promise<BackupCreateResult> {
  const nowMs = resolveDateTimestampMs(opts.nowMs);
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const plan =
    preparedPlan ?? (await resolveBackupPlanFromDisk({ includeWorkspace, onlyConfig, nowMs }));
  const selection = plan.databaseSelection;
  if (!preparedPlan && !opts.dryRun && selection?.postgres && plan.databaseConfig) {
    return runOfflineDatabaseBackup(
      plan.stateDir,
      () => createBackupArchiveInScope({ ...opts, nowMs }, plan),
      { config: plan.databaseConfig, selection },
    );
  }
  const outputPath = await resolveOutputPath({
    output: opts.output,
    nowMs,
    includedAssets: plan.included,
    stateDir: plan.stateDir,
  });

  if (plan.included.length === 0) {
    throw new Error(
      onlyConfig
        ? "No OpenClaw config file was found to back up."
        : "No local OpenClaw state was found to back up.",
    );
  }

  const canonicalOutputPath = await canonicalizePathForContainment(outputPath);
  const overlappingAsset = plan.included.find((asset) =>
    isPathInside(asset.sourcePath, canonicalOutputPath),
  );
  if (overlappingAsset) {
    throw new Error(
      `Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`,
    );
  }

  if (!opts.dryRun) {
    await assertOutputPathReady(outputPath);
  }

  const createdAt = new Date(nowMs).toISOString();
  const stateAsset = plan.included.find((asset) => asset.kind === "state");
  const stateDir = plan.resources.stateDir;
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    assets: plan.included,
    ...(onlyConfig
      ? {}
      : {
          agentRoots: plan.resources.agentRoots.map(({ agentId, sourcePath }) => ({
            agentId,
            sourcePath,
          })),
        }),
    skipped: plan.skipped,
    skippedVolatileCount: 0,
  };

  if (opts.dryRun) {
    return result;
  }

  await prepareBackupOutputParent(outputPath);
  const tempRoot = await chooseBackupTempRoot({ assets: result.assets, outputPath });
  await fs.mkdir(tempRoot, { recursive: true });
  const maintenance = await maintainBackupScratch({
    roots: [tempRoot],
    repair: true,
    log: opts.log,
  });
  if (maintenance.warnings.length) {
    result.warnings = maintenance.warnings;
  }
  for (const directory of maintenance.reclaimed) {
    opts.log?.(`Removed abandoned backup scratch: ${directory}`);
  }
  const scratch = await createBackupScratchDirectory(tempRoot);
  const tempDir = scratch.directory;
  let publication: BackupArchivePublication;
  try {
    publication = await createBackupArchivePublication(outputPath);
  } catch (error) {
    await finishBackupScratch(scratch, opts.log);
    throw formatBackupOutputFailure(error, outputPath, "publication");
  }
  const tempArchivePath = publication.tempArchivePath;
  let snapshotFacts: readonly BackupSqliteSnapshotFact[] = [];
  try {
    const configRemaps = await stageBackupConfigCapture(plan.configCapture, tempDir);
    const { legacyAuditSnapshots, stateSqliteBackup } = await createConsistentStateSnapshotPlan({
      resources: plan.resources,
      stateDir: stateAsset?.sourcePath,
      tempDir,
      onlyConfig,
    });
    const inventory = stateSqliteBackup.inventory;
    snapshotFacts = describeCapturedBackupSqliteSnapshots(
      inventory,
      stateSqliteBackup.snapshots.map((snapshot) => snapshot.archiveSourcePath),
    );
    const sourcePathRemaps = new Map(configRemaps);
    const skippedStateSourcePaths = new Set(configRemaps.values());
    if (plan.configCapture?.files.length === 0) {
      // A config created after sealing must not introduce an uncaptured graph.
      skippedStateSourcePaths.add(path.resolve(plan.configPath));
      skippedStateSourcePaths.add(await canonicalizePathForContainment(plan.configPath));
    }
    for (const snapshot of [...stateSqliteBackup.snapshots, ...legacyAuditSnapshots]) {
      sourcePathRemaps.set(path.resolve(snapshot.sourcePath), snapshot.archiveSourcePath);
      for (const skippedSourcePath of snapshot.skippedSourcePaths) {
        skippedStateSourcePaths.add(skippedSourcePath);
      }
    }
    const clientDirectories = new Set(
      inventory.coreDatabases
        .filter((database) => database.role === "client" && database.identity)
        .map((database) => path.dirname(database.sourcePath)),
    );
    // Emit private client directories before snapshots create implicit tar parents.
    const requiredSourcePaths = new Set([
      ...clientDirectories,
      ...sourcePathRemaps.keys(),
      ...result.assets.map((asset) => asset.sourcePath),
    ]);
    const externalSymbolicLinks: BackupSymbolicLink[] = [];

    const tar = await loadTarRuntime();
    const gatewayLockDir = resolveGatewayLockDir(plan.stateDir);
    const skippedEntries = new Map<string, "volatile" | "vanished">();
    const opaqueSqliteSourcePaths = new Map<string, "archived" | "skipped">();
    // Linked state roots can have distinct configured and canonical capture siblings.
    // Otherwise the inventory owns privacy admission, except for config-only exports.
    const checkConfiguredCaptureRoot = onlyConfig || plan.stateDir !== inventory.stateDir;
    const tarFilter = (entryPath: string, entryStat: import("node:fs").Stats): boolean => {
      const resolvedEntryPath = path.resolve(entryPath);
      const inventoryPath = sourcePathRemaps.get(resolvedEntryPath) ?? resolvedEntryPath;
      if (checkConfiguredCaptureRoot && isUpdateCapturePath(inventoryPath, plan.stateDir)) {
        return false;
      }
      const isDirectory = entryStat.isDirectory();
      // Staged images retain the sealed source's policy, even when scratch lives
      // beside the archive in an excluded update-capture directory.
      if (
        !onlyConfig &&
        !(isDirectory || entryStat.isSymbolicLink()
          ? inventory.isTraversable(inventoryPath)
          : inventory.isIncluded(inventoryPath))
      ) {
        return false;
      }
      if (isPathInside(gatewayLockDir, resolvedEntryPath)) {
        return false;
      }
      if (
        stateAsset &&
        isLegacyAuditMigrationBackupPath(resolvedEntryPath, stateAsset.sourcePath)
      ) {
        return false;
      }
      const sqliteSourceKind = onlyConfig
        ? undefined
        : classifyBackupSqliteSource(resolvedEntryPath, inventory);
      if (sqliteSourceKind === "opaque-skip") {
        opaqueSqliteSourcePaths.set(resolvedEntryPath, "skipped");
        return false;
      }
      if (sqliteSourceKind === "excluded") {
        return false;
      }
      if (sqliteSourceKind === "sqlite" && (entryStat.isFile() || entryStat.isSymbolicLink())) {
        throw new Error(
          `SQLite state appeared after snapshot discovery: ${entryPath}. Retry backup so it can be snapshotted.`,
        );
      }
      if (sqliteSourceKind === "opaque" && entryStat.isFile()) {
        opaqueSqliteSourcePaths.set(resolvedEntryPath, "archived");
      }
      return true;
    };
    const completedArchive = await writeTarArchiveWithRetry({
      tempArchivePath,
      log: opts.log,
      runTar: async (attemptTempArchivePath) => {
        const visitedClientDirectories = new Set<string>();
        // Keep vanished paths across retries unless a later attempt archives them.
        for (const [sourcePath, reason] of skippedEntries) {
          if (reason === "volatile") {
            skippedEntries.delete(sourcePath);
          }
        }
        externalSymbolicLinks.length = 0;
        opaqueSqliteSourcePaths.clear();
        const prepared = await writeArchiveStreamToFile({
          archivePath: attemptTempArchivePath,
          createArchiveStream: (reportProgress, signal) =>
            appendBackupManifest(
              walkBackupTar({
                tar,
                signal,
                paths: [...requiredSourcePaths],
                skip: (sourcePath) => {
                  if (clientDirectories.has(sourcePath)) {
                    if (visitedClientDirectories.has(sourcePath)) {
                      return true;
                    }
                    visitedClientDirectories.add(sourcePath);
                  }
                  if (!requiredSourcePaths.has(sourcePath) && inventory.isVolatile(sourcePath)) {
                    skippedEntries.set(sourcePath, "volatile");
                    return true;
                  }
                  // Captured config/database originals and sidecars never need lstat.
                  return (
                    skippedStateSourcePaths.has(sourcePath) ||
                    stateSqliteBackup.discoveredSourcePaths.has(sourcePath)
                  );
                },
                filter: tarFilter,
                onVanished: (sourcePath) => {
                  if (requiredSourcePaths.has(sourcePath)) {
                    throw new Error(`Required backup source disappeared: ${sourcePath}`);
                  }
                  opaqueSqliteSourcePaths.delete(sourcePath);
                  skippedEntries.set(sourcePath, "vanished");
                },
                onProgress: (entryPath, bytes) =>
                  reportProgress({
                    phase: bytes === undefined ? "traversal" : "raw",
                    entryPath,
                    bytes,
                  }),
                onEntry: (sourcePath, header) => {
                  skippedEntries.delete(sourcePath);
                  const archiveEntryPath = buildBackupArchivePath(
                    archiveRoot,
                    sourcePathRemaps.get(sourcePath) ?? sourcePath,
                  );
                  if (header.type === "SymbolicLink") {
                    const { external, ...link } = recordArchiveSymbolicLink({
                      archiveRoot,
                      entryPath: archiveEntryPath,
                      linkpath: header.linkpath,
                      platform: process.platform,
                      state: {
                        sourcePath: stateDir,
                        archivePath: buildBackupArchivePath(archiveRoot, stateDir),
                      },
                      hasExternalLinkReport: true,
                      assets: result.assets,
                    });
                    if (external) {
                      externalSymbolicLinks.push(link);
                    }
                  }
                  header.path = archiveEntryPath;
                },
              }),
              () => {
                result.skipped = [
                  ...plan.skipped,
                  ...[...skippedEntries].map(([sourcePath, reason]) => ({
                    kind: "entry",
                    sourcePath,
                    displayPath: sourcePath,
                    reason,
                  })),
                ];
                // Per-entry reports must not overflow the bounded restore manifest.
                const manifest = buildManifest({ ...result, skipped: plan.skipped }, plan);
                if (stateSqliteBackup.sharedDatabaseSourcePath !== undefined) {
                  manifest.paths = {
                    ...manifest.paths,
                    sharedDatabaseSourcePath: stateSqliteBackup.sharedDatabaseSourcePath,
                  };
                }
                manifest.externalSymbolicLinks = externalSymbolicLinks;
                manifest.sqliteSnapshots = snapshotFacts.map((snapshot) =>
                  snapshot.role === "agent"
                    ? { sourcePath: snapshot.sourcePath, role: "agent", agentId: snapshot.agentId }
                    : { sourcePath: snapshot.sourcePath, role: "global" },
                );
                manifest.postgresSnapshots = stateSqliteBackup.postgresSnapshots.map(
                  (snapshot) => ({
                    archivePath: `${buildBackupArchivePath(archiveRoot, snapshot.sourcePath)}.postgres`,
                    manifestSha256: snapshot.manifestSha256,
                  }),
                );
                return encodeBackupManifest(manifest);
              },
            ),
          onPartialArchive: (partialArchive) => {
            publication.pendingCleanupArchives.push(partialArchive);
          },
        });
        try {
          await plan.configCapture?.assertRootAlias?.();
        } catch (error) {
          if (!removePreparedBackupArchive(prepared)) {
            publication.pendingCleanupArchives.push(prepared);
          }
          throw error;
        }
        return prepared;
      },
    }).catch((error: unknown) => {
      throw formatBackupOutputFailure(error, outputPath, "write", publication.stagingDir);
    });
    result.skippedVolatileCount = [...skippedEntries.values()].filter(
      (reason) => reason === "volatile",
    ).length;
    const archiveWarnings = [
      ...[...opaqueSqliteSourcePaths]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([sourcePath, action]) =>
          action === "skipped"
            ? `Skipped unresolvable opaque SQLite link: ${sourcePath}`
            : `SQLite file archived as opaque bytes without a live snapshot or integrity checks: ${sourcePath}`,
        ),
      ...[...skippedEntries]
        .filter(([, reason]) => reason === "vanished")
        .map(([sourcePath]) => `Skipped vanished entry (ENOENT): ${sourcePath}`),
    ];
    if (archiveWarnings.length) {
      result.warnings = [...(result.warnings ?? []), ...archiveWarnings];
    }
    if (externalSymbolicLinks.length) {
      result.externalSymbolicLinks = externalSymbolicLinks;
    }
    if (result.skippedVolatileCount > 0) {
      opts.log?.(
        `Backup skipped ${result.skippedVolatileCount} volatile file${
          result.skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).`,
      );
    }
    try {
      await publishPreparedBackupArchive({
        plan: publication,
        prepared: completedArchive,
        log: opts.log,
      });
    } catch (error) {
      throw formatBackupOutputFailure(error, outputPath, "publication");
    }
  } finally {
    try {
      await cleanupBackupArchivePublication(publication, opts.log);
    } finally {
      const warning = await finishBackupScratch(scratch, opts.log);
      if (warning) {
        result.warnings = [...(result.warnings ?? []), warning];
      }
    }
  }

  opts.onSqliteSnapshots?.(snapshotFacts);
  return result;
}
