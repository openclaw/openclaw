import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  buildExcludeFilter,
  resolveExcludePatterns,
  type ExcludeSpec,
} from "../commands/backup-exclude.js";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
  type ExcludedEntry,
  type ExcludedStats,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  // Exclude options
  smartExclude?: boolean;
  exclude?: string[];
  excludeFile?: string;
  includeAll?: boolean;
  allowExcludeProtected?: boolean;
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
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
    smartExclude?: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: BackupManifestAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
    coveredBy?: string;
  }>;
  excluded?: ExcludedEntry[];
  excludedStats?: ExcludedStats;
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
  excluded?: ExcludedEntry[];
  excludedStats?: ExcludedStats;
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
  smartExclude: boolean;
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  excluded?: ExcludedEntry[];
  excludedStats?: ExcludedStats;
}): BackupManifest {
  const manifest: BackupManifest = {
    schemaVersion: 1,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: params.includeWorkspace,
      onlyConfig: params.onlyConfig,
      ...(params.smartExclude ? { smartExclude: true } : {}),
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
    skipped: params.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
  if (params.excluded && params.excluded.length > 0) {
    manifest.excluded = params.excluded;
  }
  if (params.excludedStats) {
    manifest.excludedStats = params.excludedStats;
  }
  return manifest;
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
  if (result.excluded && result.excluded.length > 0) {
    lines.push(
      `Excluded ${result.excluded.length} path${result.excluded.length === 1 ? "" : "s"}:`,
    );
    const displayLimit = 20;
    const toShow = result.excluded.slice(0, displayLimit);
    for (const entry of toShow) {
      lines.push(`- ${entry.path} (${entry.pattern}, ${entry.source})`);
    }
    if (result.excluded.length > displayLimit) {
      lines.push(`  … and ${result.excluded.length - displayLimit} more`);
    }
    if (result.excludedStats) {
      const mb = (result.excludedStats.totalBytes / (1024 * 1024)).toFixed(1);
      lines.push(`Excluded ${result.excludedStats.totalFiles} files (${mb} MB)`);
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
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

function buildExcludedStats(excluded: readonly ExcludedEntry[]): ExcludedStats {
  const byPatternMap = new Map<string, { files: number; bytes: number; source: string }>();
  for (const entry of excluded) {
    const existing = byPatternMap.get(entry.pattern);
    if (existing) {
      existing.files += 1;
      existing.bytes += entry.bytes;
    } else {
      byPatternMap.set(entry.pattern, {
        files: 1,
        bytes: entry.bytes,
        source: entry.source,
      });
    }
  }
  return {
    totalFiles: excluded.length,
    totalBytes: excluded.reduce((sum, e) => sum + e.bytes, 0),
    byPattern: [...byPatternMap.entries()].map(([pattern, stats]) => ({
      pattern,
      ...stats,
    })),
  };
}

export async function createBackupArchive(
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const smartExclude = Boolean(opts.smartExclude);
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

  // Pre-flight: resolve exclude patterns BEFORE any archive I/O.
  const excludeSpec: ExcludeSpec = {
    exclude: opts.exclude ?? [],
    excludeFile: opts.excludeFile,
    includeAll: Boolean(opts.includeAll),
    smartExclude,
    allowExcludeProtected: Boolean(opts.allowExcludeProtected),
    nonInteractive: false,
  };
  const { patterns: excludePatterns, sources: patternSources } = resolveExcludePatterns(
    excludeSpec,
    plan.stateDir,
  );

  // Build the filter once (pre-compiled, outside the hot path).
  const { filter: excludeFilter, getExcluded } = buildExcludeFilter(
    excludePatterns,
    patternSources,
    plan.stateDir,
  );

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
    // For dry-run, populate excluded info if patterns are active.
    if (excludePatterns.length > 0) {
      result.excluded = [];
      result.excludedStats = {
        totalFiles: 0,
        totalBytes: 0,
        byPattern: excludePatterns.map((p) => ({
          pattern: p,
          files: 0,
          bytes: 0,
          source: patternSources.get(p) ?? "cli",
        })),
      };
    }
    return result;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = buildTempArchivePath(outputPath);
  try {
    const hasExcludes = excludePatterns.length > 0;

    // Write manifest. The excluded[] field is populated after tar completes
    // via the filter side-effect. The in-archive manifest records options
    // but not the runtime excluded list (which is on the result object).
    const manifest = buildManifest({
      createdAt,
      archiveRoot,
      includeWorkspace,
      onlyConfig,
      smartExclude,
      assets: result.assets,
      skipped: result.skipped,
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const tarFilter = hasExcludes
      ? (entryPath: string, stat: { size?: number }) => {
          // Never filter out the manifest file itself.
          if (path.resolve(entryPath) === manifestPath) {
            return true;
          }
          return excludeFilter(entryPath, stat);
        }
      : undefined;

    const tarOpts: tar.TarOptionsWithAliasesAsyncFile = {
      file: tempArchivePath,
      gzip: true,
      portable: true,
      preservePaths: true,
      follow: false, // SECURITY: never follow symlinks
      onWriteEntry: (entry) => {
        entry.path = remapArchiveEntryPath({
          entryPath: entry.path,
          manifestPath,
          archiveRoot,
        });
      },
    };
    if (tarFilter) {
      tarOpts.filter = tarFilter;
    }

    await tar.c(tarOpts, [manifestPath, ...result.assets.map((asset) => asset.sourcePath)]);

    // Populate result with excluded entries from filter side-effect.
    if (hasExcludes) {
      const excluded = getExcluded();
      if (excluded.length > 0) {
        result.excluded = [...excluded];
        result.excludedStats = buildExcludedStats(excluded);
      }
    }

    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
