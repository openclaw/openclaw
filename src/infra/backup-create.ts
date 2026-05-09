import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { recordOpenClawStateBackupRun } from "../state/openclaw-state-db.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { writeJson } from "./json-files.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { assertSqliteIntegrityOk } from "./sqlite-integrity.js";

type TarRuntime = typeof import("tar");

let tarRuntimePromise: Promise<TarRuntime> | undefined;

function loadTarRuntime(): Promise<TarRuntime> {
  tarRuntimePromise ??= import("tar");
  return tarRuntimePromise;
}

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  log?: (message: string) => void;
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
};

type BackupManifestDatabaseSnapshot = {
  role: "global" | "agent" | "state";
  agentId?: string;
  sourcePath: string;
  archivePath: string;
  byteSize: number;
  integrity: "ok";
};

type BackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  options: {
    includeWorkspace: boolean;
    onlyConfig?: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: BackupManifestAsset[];
  databaseSnapshots: BackupManifestDatabaseSnapshot[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  assets: BackupAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    displayPath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

async function resolveOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: BackupAsset[];
  stateDir: string;
}): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    const cwd = path.resolve(process.cwd());
    const canonicalCwd = await fs.realpath(cwd).catch(() => cwd);
    const cwdInsideSource = params.includedAssets.some((asset) =>
      isPathWithin(canonicalCwd, asset.sourcePath),
    );
    const defaultDir = cwdInsideSource ? (resolveHomeDir() ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveUserPath(rawOutput);
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Treat as a file path when the target does not exist yet.
  }

  return resolved;
}

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function buildTempArchivePath(outputPath: string): string {
  return `${outputPath}.${randomUUID()}.tmp`;
}

// The temp manifest is passed to `tar.c` alongside the asset source paths. If
// the temp file lives inside any asset, recursive traversal pulls it in a
// second time and both copies remap to `<archiveRoot>/manifest.json`, which
// makes verify reject the archive. A `tar` filter cannot fix this in place: it
// fires for both the explicit-arg and the traversed entry, so excluding by
// path drops the manifest entirely. We instead place the temp dir somewhere
// guaranteed to be outside every asset.
async function chooseBackupTempRoot(params: {
  assets: readonly BackupAsset[];
  outputPath: string;
}): Promise<string> {
  const systemTmp = os.tmpdir();
  const canonicalSystemTmp = await canonicalizePathForContainment(systemTmp);
  const systemTmpInsideAsset = params.assets.some((asset) =>
    isPathWithin(canonicalSystemTmp, asset.sourcePath),
  );
  if (!systemTmpInsideAsset) {
    return systemTmp;
  }

  // Fallback: the directory holding the output archive. The earlier
  // output-containment check guarantees `outputPath` is outside every asset,
  // so its parent is too. The caller must already have write access there to
  // write the archive itself, so this stays within the existing sandbox.
  const fallback = path.dirname(params.outputPath);
  const canonicalFallback = await canonicalizePathForContainment(fallback);
  const fallbackInsideAsset = params.assets.find((asset) =>
    isPathWithin(canonicalFallback, asset.sourcePath),
  );
  if (fallbackInsideAsset) {
    throw new Error(
      `Backup temp root cannot be placed outside every source path: ${systemTmp} and ${fallback} both overlap ${fallbackInsideAsset.sourcePath}.`,
    );
  }
  return fallback;
}

function isLinkUnsupportedError(code: string | undefined): boolean {
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

async function publishTempArchive(params: {
  tempArchivePath: string;
  outputPath: string;
}): Promise<void> {
  try {
    await fs.link(params.tempArchivePath, params.outputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
        cause: err,
      });
    }
    if (!isLinkUnsupportedError(code)) {
      throw err;
    }

    try {
      // Some backup targets support ordinary files but not hard links.
      await fs.copyFile(params.tempArchivePath, params.outputPath, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      const copyCode = (copyErr as NodeJS.ErrnoException | undefined)?.code;
      if (copyCode !== "EEXIST") {
        await fs.rm(params.outputPath, { force: true }).catch(() => undefined);
      }
      if (copyCode === "EEXIST") {
        throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
          cause: copyErr,
        });
      }
      throw copyErr;
    }
  }
  await fs.rm(params.tempArchivePath, { force: true });
}

async function canonicalizePathForContainment(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function buildManifest(params: {
  createdAt: string;
  archiveRoot: string;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  databaseSnapshots?: BackupManifestDatabaseSnapshot[];
}): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: params.includeWorkspace,
      onlyConfig: params.onlyConfig,
    },
    paths: {
      stateDir: params.stateDir,
      configPath: params.configPath,
      oauthDir: params.oauthDir,
      workspaceDirs: params.workspaceDirs,
    },
    assets: params.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    databaseSnapshots: params.databaseSnapshots ?? [],
    skipped: params.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
}

export function formatBackupCreateSummary(result: BackupCreateResult): string[] {
  const lines = [`Backup archive: ${result.archivePath}`];
  lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    lines.push(`- ${asset.kind}: ${asset.displayPath}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      if (entry.reason === "covered" && entry.coveredBy) {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason} by ${entry.coveredBy})`);
      } else {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
      }
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
    if (result.verified) {
      lines.push("Archive verification: passed");
    }
  }
  return lines;
}

function remapArchiveEntryPath(params: {
  entryPath: string;
  manifestPath: string;
  archiveRoot: string;
  stagedAssets?: StagedBackupAssets;
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  const stagedState = params.stagedAssets?.state;
  if (stagedState && isPathWithin(normalizedEntry, stagedState.stagedPath)) {
    const relative = path.relative(stagedState.stagedPath, normalizedEntry);
    return path.posix.join(stagedState.asset.archivePath, relative.split(path.sep).join("/"));
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

function normalizeBackupFilterPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function buildExtensionsNodeModulesFilter(stateDir: string): (filePath: string) => boolean {
  const normalizedStateDir = normalizeBackupFilterPath(stateDir);
  const extensionsPrefix = `${normalizedStateDir}/extensions/`;

  return (filePath: string): boolean => {
    const normalizedFilePath = normalizeBackupFilterPath(filePath);
    if (!normalizedFilePath.startsWith(extensionsPrefix)) {
      return true;
    }

    return !normalizedFilePath.slice(extensionsPrefix.length).split("/").includes("node_modules");
  };
}

type StagedBackupAssets = {
  archivePaths: string[];
  databaseSnapshots: BackupManifestDatabaseSnapshot[];
  state?: {
    asset: BackupAsset;
    stagedPath: string;
  };
};

function isSqliteSidecarPath(filePath: string): boolean {
  return filePath.endsWith(".sqlite-wal") || filePath.endsWith(".sqlite-shm");
}

function isSqliteDatabasePath(filePath: string): boolean {
  return filePath.endsWith(".sqlite");
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function listSqliteDatabasePaths(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isSqliteDatabasePath(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results.toSorted();
}

function classifySqliteSnapshotRole(params: {
  stateDir: string;
  sqlitePath: string;
}): Pick<BackupManifestDatabaseSnapshot, "role" | "agentId"> {
  const relative = path.relative(params.stateDir, params.sqlitePath).split(path.sep).join("/");
  if (relative === "state/openclaw.sqlite") {
    return { role: "global" };
  }
  const agentMatch = relative.match(/^agents\/([^/]+)\/agent\/openclaw-agent\.sqlite$/u);
  if (agentMatch?.[1]) {
    return { role: "agent", agentId: agentMatch[1] };
  }
  return { role: "state" };
}

async function snapshotSqliteDatabase(params: {
  sourcePath: string;
  snapshotPath: string;
}): Promise<{ byteSize: number }> {
  await fs.mkdir(path.dirname(params.snapshotPath), { recursive: true });
  await fs.rm(params.snapshotPath, { force: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(params.sourcePath);
  try {
    try {
      db.exec("PRAGMA wal_checkpoint(FULL);");
    } catch {
      // Best effort: VACUUM INTO still creates a consistent snapshot.
    }
    db.exec(`VACUUM INTO ${sqlStringLiteral(params.snapshotPath)};`);
  } finally {
    db.close();
  }
  const integrityDb = new sqlite.DatabaseSync(params.snapshotPath, { readOnly: true });
  try {
    assertSqliteIntegrityOk(
      integrityDb,
      `SQLite integrity check failed for backup snapshot: ${params.sourcePath}`,
    );
  } finally {
    integrityDb.close();
  }
  const stat = await fs.stat(params.snapshotPath);
  return { byteSize: stat.size };
}

async function stageBackupAssets(params: {
  assets: BackupAsset[];
  tempDir: string;
}): Promise<StagedBackupAssets> {
  const archivePaths: string[] = [];
  const databaseSnapshots: BackupManifestDatabaseSnapshot[] = [];
  let stagedState: StagedBackupAssets["state"];

  for (const asset of params.assets) {
    if (asset.kind !== "state") {
      archivePaths.push(asset.sourcePath);
      continue;
    }

    const stagedPath = path.join(params.tempDir, "state-snapshot");
    await fs.cp(asset.sourcePath, stagedPath, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !isSqliteDatabasePath(source) && !isSqliteSidecarPath(source),
    });

    for (const sqlitePath of await listSqliteDatabasePaths(asset.sourcePath)) {
      const relative = path.relative(asset.sourcePath, sqlitePath);
      const snapshotPath = path.join(stagedPath, relative);
      const snapshot = await snapshotSqliteDatabase({
        sourcePath: sqlitePath,
        snapshotPath,
      });
      const role = classifySqliteSnapshotRole({
        stateDir: asset.sourcePath,
        sqlitePath,
      });
      databaseSnapshots.push({
        ...role,
        sourcePath: sqlitePath,
        archivePath: path.posix.join(asset.archivePath, relative.split(path.sep).join("/")),
        byteSize: snapshot.byteSize,
        integrity: "ok",
      });
    }

    stagedState = { asset, stagedPath };
    archivePaths.push(stagedPath);
  }

  return { archivePaths, databaseSnapshots, state: stagedState };
}

export async function createBackupArchive(
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace, onlyConfig, nowMs });
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
    isPathWithin(canonicalOutputPath, asset.sourcePath),
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
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    assets: plan.included,
    skipped: plan.skipped,
  };

  if (opts.dryRun) {
    return result;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempRoot = await chooseBackupTempRoot({ assets: result.assets, outputPath });
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = buildTempArchivePath(outputPath);
  let manifest: BackupManifest | undefined;
  try {
    const stagedAssets = await stageBackupAssets({
      assets: result.assets,
      tempDir,
    });
    manifest = buildManifest({
      createdAt,
      archiveRoot,
      includeWorkspace,
      onlyConfig,
      assets: result.assets,
      skipped: result.skipped,
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
      databaseSnapshots: stagedAssets.databaseSnapshots,
    });
    await writeJson(manifestPath, manifest, { trailingNewline: true });

    const tar = await loadTarRuntime();
    const filter = stagedAssets.state
      ? buildExtensionsNodeModulesFilter(stagedAssets.state.stagedPath)
      : undefined;
    await tar.c(
      {
        file: tempArchivePath,
        ...(filter ? { filter } : {}),
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          entry.path = remapArchiveEntryPath({
            entryPath: entry.path,
            manifestPath,
            archiveRoot,
            stagedAssets,
          });
        },
      },
      [manifestPath, ...stagedAssets.archivePaths],
    );
    await publishTempArchive({ tempArchivePath, outputPath });
    if (manifest && result.assets.some((asset) => asset.kind === "state")) {
      recordOpenClawStateBackupRun({
        createdAt: nowMs,
        archivePath: outputPath,
        status: "completed",
        manifest: manifest as unknown as Record<string, unknown>,
      });
    }
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
