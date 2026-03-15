import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
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
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
  sha256: string;
};

type BackupManifest = {
  schemaVersion: 2;
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
  assetChecksums: Map<string, string>;
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
}): BackupManifest {
  return {
    schemaVersion: 2,
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
    assets: params.assets.map((asset) => {
      const sha256 = params.assetChecksums.get(asset.sourcePath);
      if (sha256 === undefined) {
        throw new Error(`Missing checksum for asset: ${asset.sourcePath}`);
      }
      return {
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        archivePath: asset.archivePath,
        sha256,
      };
    }),
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

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function collectFileHashes(
  dirPath: string,
): Promise<Array<{ relativePath: string; sha256: string }>> {
  const entries: Array<{ relativePath: string; sha256: string }> = [];
  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const sha256 = await hashFile(fullPath);
        const relativePath = path.relative(dirPath, fullPath).replaceAll("\\", "/");
        entries.push({ relativePath, sha256 });
      }
    }
  }
  await walk(dirPath);
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return entries;
}

async function computeAssetHash(assetPath: string): Promise<string> {
  const stat = await fs.stat(assetPath);
  if (stat.isFile()) {
    return hashFile(assetPath);
  }
  const fileHashes = await collectFileHashes(assetPath);
  const hash = createHash("sha256");
  for (const entry of fileHashes) {
    hash.update(`${entry.relativePath}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = buildTempArchivePath(outputPath);
  const initialArchivePath = `${tempArchivePath}.initial`;
  try {
    const manifestParams = {
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
    };

    // --- Pass 1: Pack source files with placeholder checksums ---
    // Checksums are zeroed out here; we derive real checksums from the archived
    // bytes in pass 2 to avoid TOCTOU (a file changing between hash and pack).
    const placeholderChecksums = new Map<string, string>();
    for (const asset of result.assets) {
      placeholderChecksums.set(asset.sourcePath, "0".repeat(64));
    }
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(buildManifest({ ...manifestParams, assetChecksums: placeholderChecksums }), null, 2)}\n`,
      "utf8",
    );
    await tar.c(
      {
        file: initialArchivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          entry.path = remapArchiveEntryPath({ entryPath: entry.path, manifestPath, archiveRoot });
        },
      },
      [...result.assets.map((asset) => asset.sourcePath), manifestPath],
    );

    // --- Pass 2: Extract, hash archived bytes, repack with correct checksums ---
    // Hashing the extracted files (not the live source files) ensures checksums
    // reflect the bytes actually archived, eliminating the TOCTOU window.
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-stage-"));
    try {
      await tar.x({ file: initialArchivePath, cwd: stagingDir, gzip: true });

      const assetChecksums = new Map<string, string>();
      for (const asset of result.assets) {
        const extractedPath = path.join(stagingDir, asset.archivePath);
        assetChecksums.set(asset.sourcePath, await computeAssetHash(extractedPath));
      }

      const stagingManifestPath = path.join(stagingDir, archiveRoot, "manifest.json");
      await fs.writeFile(
        stagingManifestPath,
        `${JSON.stringify(buildManifest({ ...manifestParams, assetChecksums }), null, 2)}\n`,
        "utf8",
      );

      await tar.c({ file: tempArchivePath, gzip: true, portable: true, cwd: stagingDir }, [
        archiveRoot,
      ]);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }

    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    await fs.rm(initialArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
