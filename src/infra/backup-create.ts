import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as tar from "tar";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  listArchiveEntries,
  type BackupAsset,
  type BackupManifestBase,
  type ExcludedStats,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { buildExcludeFilter, resolveExcludePatterns, type ExcludeSpec } from "./backup-exclude.js";

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
  nonInteractive?: boolean;
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
};

// P2-012: Writer manifest extends shared base with strict types.
type BackupManifest = BackupManifestBase & {
  schemaVersion: 1;
  platform: NodeJS.Platform;
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
  if (result.excludedStats && result.excludedStats.totalFiles > 0) {
    const mb = (result.excludedStats.totalBytes / (1024 * 1024)).toFixed(1);
    lines.push(`Excluded ${result.excludedStats.totalFiles} files (${mb} MB)`);
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
    nonInteractive: Boolean(opts.nonInteractive),
  };
  const { patterns: excludePatterns, sources: patternSources } = await resolveExcludePatterns(
    excludeSpec,
    plan.stateDir,
  );

  // Build the filter once (pre-compiled, outside the hot path).
  // Canonicalize stateDir so short-path aliases (e.g. RUNNER~1 on Windows)
  // don't cause relative() mismatches against realpath'd asset.sourcePath.
  const canonicalStateDir = await fs.realpath(plan.stateDir).catch(() => plan.stateDir);
  const { filter: excludeFilter, getExcludedStats } = buildExcludeFilter(
    excludePatterns,
    patternSources,
    canonicalStateDir,
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
    // For dry-run, populate excludedStats with zero-count patterns if active.
    if (excludePatterns.length > 0) {
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
  // Bug B fix: declared outside try/finally so cleanup can reach it.
  let uncompressedTarPath: string | undefined;
  try {
    const hasExcludes = excludePatterns.length > 0;

    const manifestBuildParams = {
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
    };

    // Shared tar options — single source of truth so the two archive paths
    // cannot diverge (divergence caused the Windows CI failures in Finding 9).
    const baseTarOpts = {
      portable: true,
      preservePaths: true,
      follow: false,
      onWriteEntry: (entry: tar.WriteEntry) => {
        entry.path = remapArchiveEntryPath({
          entryPath: entry.path,
          manifestPath,
          archiveRoot,
        });
      },
    } as const;

    if (hasExcludes) {
      // Two-step archive creation: create uncompressed tar with payload only,
      // collect excludedStats via filter side-effect, write the final
      // manifest (with excludedStats) and append it, then gzip.
      // This ensures the in-archive manifest accurately records what was excluded.
      uncompressedTarPath = `${tempArchivePath}.tar`;

      await tar.c(
        {
          ...baseTarOpts,
          file: uncompressedTarPath,
          filter: (entryPath: string, stat: { size?: number }) => {
            return excludeFilter(entryPath, stat);
          },
        },
        result.assets.map((asset) => asset.sourcePath),
      );

      // Collect per-pattern exclusion stats from filter side-effect.
      const excludedStats = getExcludedStats();
      if (excludedStats.totalFiles > 0) {
        result.excludedStats = excludedStats;
      }

      // Write final manifest WITH excludedStats.
      const manifest = buildManifest({
        ...manifestBuildParams,
        excludedStats: result.excludedStats,
      });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      // Append manifest to uncompressed tar (single entry, no duplicates).
      await tar.r(
        {
          file: uncompressedTarPath,
          cwd: path.dirname(manifestPath),
          onWriteEntry: (entry) => {
            entry.path = path.posix.join(archiveRoot, "manifest.json");
          },
        },
        [path.basename(manifestPath)],
      );

      // Gzip the uncompressed tar to produce the final .tar.gz.
      await pipeline(
        createReadStream(uncompressedTarPath),
        createGzip(),
        createWriteStream(tempArchivePath),
      );
      await fs.rm(uncompressedTarPath, { force: true });
    } else {
      // Simple path: no excludes — write manifest and create gzipped tar in one step.
      const manifest = buildManifest(manifestBuildParams);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      await tar.c(
        {
          ...baseTarOpts,
          file: tempArchivePath,
          gzip: true,
        },
        [manifestPath, ...result.assets.map((asset) => asset.sourcePath)],
      );
    }

    // P3-016: Post-tar cross-check — verify archive contains expected assets.
    // excludedStats provides auditability only; asset presence is verified unconditionally
    {
      const archiveEntries = await listArchiveEntries(tempArchivePath);
      const entrySet = new Set(archiveEntries);
      for (const asset of result.assets) {
        const expectedPath = buildBackupArchivePath(archiveRoot, asset.sourcePath);
        // Check for exact match or nested entries under this path.
        const found =
          entrySet.has(expectedPath) ||
          archiveEntries.some((e) => e.startsWith(`${expectedPath}/`));
        if (!found) {
          throw new Error(
            `Archive integrity check failed: missing payload for asset "${asset.sourcePath}" (expected "${expectedPath}")`,
          );
        }
      }
    }

    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    if (uncompressedTarPath) {
      await fs.rm(uncompressedTarPath, { force: true }).catch(() => undefined);
    }
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
