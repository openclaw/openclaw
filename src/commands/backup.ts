import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import {
  buildBackupArchiveBasename,
  buildBackupArchiveRoot,
  buildBackupArchivePath,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import { backupVerifyCommand } from "./backup-verify.js";
import { isPathWithin } from "./cleanup-utils.js";

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  exclude?: string[];
  excludeFile?: string;
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
    excludePatterns?: string[];
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
};

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  excludePatterns?: string[];
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
  excludePatterns?: string[];
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
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
      excludePatterns: params.excludePatterns,
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
}

function formatTextSummary(result: BackupCreateResult): string[] {
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
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

function matchesExcludePattern(filePath: string, pattern: string): boolean {
  // Handle negation patterns (starting with !)
  const isNegation = pattern.startsWith("!");
  if (isNegation) {
    pattern = pattern.slice(1);
  }

  // Normalize path
  const normalizedPath = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalizedPath);

  // Build regex from gitignore pattern
  let regexPattern = pattern;

  // Handle character classes [abc] and ranges [a-z]
  // Convert to regex: [abc] -> \[abc\], [a-z] -> \[a-z\]
  regexPattern = regexPattern.replace(/\[([^\]]+)\]/g, (match) => {
    return "[" + match.slice(1, -1) + "]";
  });

  // Handle ** (matches directories recursively)
  // **/foo matches foo at any level
  // foo/** matches everything under foo
  if (regexPattern.startsWith("**/")) {
    regexPattern = ".*/" + regexPattern.slice(3);
  } else if (regexPattern.endsWith("/**")) {
    regexPattern = regexPattern.slice(0, -2) + "(/.*)?";
  } else {
    // Regular * doesn't match slashes
    regexPattern = regexPattern.replace(/\*/g, "[^/]*");
  }

  // ? matches any single character except /
  regexPattern = regexPattern.replace(/\?/g, "[^/]");

  // Escape other regex special characters
  regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Match from start (anchored)
  const regex = new RegExp("^" + regexPattern + "$");

  // Check if matches full path or basename
  const matchesFull = regex.test(normalizedPath);
  const matchesBasename = regex.test(basename);

  // Handle directory patterns (ending with /)
  if (pattern.endsWith("/")) {
    const isDir =
      normalizedPath.endsWith("/") || normalizedPath.split("/").slice(-1)[0] !== basename;
    return (matchesFull || matchesBasename) && isDir;
  }

  const matched = matchesFull || matchesBasename;

  // Negation means include (opposite of exclude)
  return isNegation ? !matched : matched;
}

function filterExcludedAssets(
  assets: BackupAsset[],
  excludePatterns: string[],
): { included: BackupAsset[]; excluded: BackupAsset[] } {
  if (!excludePatterns || excludePatterns.length === 0) {
    return { included: assets, excluded: [] };
  }

  // Separate negation patterns from exclusion patterns
  const negationPatterns = excludePatterns.filter((p) => p.startsWith("!"));
  const exclusionPatterns = excludePatterns.filter((p) => !p.startsWith("!"));

  const included: BackupAsset[] = [];
  const excluded: BackupAsset[] = [];

  for (const asset of assets) {
    const sourcePath = asset.sourcePath;

    // Check exclusion patterns first
    const isExcludedByNormal = exclusionPatterns.some((pattern) =>
      matchesExcludePattern(sourcePath, pattern),
    );

    // Check negation patterns - if any negation matches, file is included
    const isNegated = negationPatterns.some((pattern) =>
      matchesExcludePattern(sourcePath, pattern),
    );

    // File is excluded if matched by exclusion pattern AND not negated
    const isExcluded = isExcludedByNormal && !isNegated;

    if (isExcluded) {
      excluded.push(asset);
    } else {
      included.push(asset);
    }
  }

  return { included, excluded };
}

async function loadExcludePatternsFromFile(filePath: string, required = false): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    // Filter out empty lines and comments
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (err) {
    if (required) {
      throw new Error(`Failed to load exclude file: ${filePath}`, { cause: err });
    }
    return [];
  }
}

async function loadIgnoreFilesFromWorkspaces(workspaceDirs: string[]): Promise<string[]> {
  const patterns: string[] = [];
  const ignoreFiles = [".gitignore", ".openclawignore"];

  for (const workspaceDir of workspaceDirs) {
    for (const ignoreFile of ignoreFiles) {
      const filePath = path.join(workspaceDir, ignoreFile);
      try {
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          const filePatterns = await loadExcludePatternsFromFile(filePath);
          // Normalize workspace path and add prefix to avoid conflicts
          const normalizedWorkspace = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
          for (const pattern of filePatterns) {
            // Normalize the pattern too
            const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
            patterns.push(`${normalizedWorkspace}/${normalizedPattern}`);
          }
        }
      } catch {
        // File doesn't exist, skip
      }
    }
  }

  return patterns;
}

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace, onlyConfig, nowMs });

  // Load exclude patterns
  let excludePatterns = opts.exclude ?? [];

  // Load from specified exclude file
  if (opts.excludeFile) {
    const filePatterns = await loadExcludePatternsFromFile(opts.excludeFile, true);
    excludePatterns = [...excludePatterns, ...filePatterns];
  }

  // Auto-load .gitignore and .openclawignore from workspace directories
  const workspacePatterns = await loadIgnoreFilesFromWorkspaces(plan.workspaceDirs);
  excludePatterns = [...excludePatterns, ...workspacePatterns];

  // Filter excluded assets
  const { included: filteredAssets, excluded: excludedAssets } = filterExcludedAssets(
    plan.included,
    excludePatterns,
  );

  // Update plan with filtered assets
  plan.included = filteredAssets;

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

  // Add excluded assets to skipped list
  const skippedFromExclude = excludedAssets.map((asset) => ({
    kind: asset.kind,
    sourcePath: asset.sourcePath,
    displayPath: asset.displayPath,
    reason: "excluded",
    coveredBy: undefined as string | undefined,
  }));

  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    excludePatterns,
    assets: plan.included,
    skipped: [...plan.skipped, ...skippedFromExclude],
  };

  if (!opts.dryRun) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    const tempArchivePath = buildTempArchivePath(outputPath);
    try {
      const manifest = buildManifest({
        createdAt,
        archiveRoot,
        includeWorkspace,
        onlyConfig,
        excludePatterns,
        assets: result.assets,
        skipped: result.skipped,
        stateDir: plan.stateDir,
        configPath: plan.configPath,
        oauthDir: plan.oauthDir,
        workspaceDirs: plan.workspaceDirs,
      });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      // Filter function to exclude individual entries within archived directories
      const filterFn = (entryPath: string): boolean => {
        // Always include manifest
        if (entryPath === manifestPath) {
          return true;
        }
        // Check against exclude patterns
        return !excludePatterns.some((pattern) => matchesExcludePattern(entryPath, pattern));
      };

      await tar.c(
        {
          file: tempArchivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          filter: filterFn,
          onWriteEntry: (entry) => {
            entry.path = remapArchiveEntryPath({
              entryPath: entry.path,
              manifestPath,
              archiveRoot,
            });
          },
        },
        [manifestPath, ...result.assets.map((asset) => asset.sourcePath)],
      );
      await publishTempArchive({ tempArchivePath, outputPath });
    } finally {
      await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (opts.verify) {
      await backupVerifyCommand(
        {
          ...runtime,
          log: () => {},
        },
        { archive: outputPath, json: false },
      );
      result.verified = true;
    }
  }

  const output = opts.json ? JSON.stringify(result, null, 2) : formatTextSummary(result).join("\n");
  runtime.log(output);
  return result;
}
