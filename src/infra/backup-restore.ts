import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { decodeAbsolutePathFromBackupArchive } from "../commands/backup-shared.js";
import { readBackupManifest } from "../commands/backup-verify.js";
import type { BackupManifest, BackupManifestAsset } from "../commands/backup-verify.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import { mergeExtractedTreeIntoDestination, prepareArchiveDestinationDir } from "./archive.js";

export type BackupRestoreOptions = {
  archive: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
};

export type RestoreAssetPlan = {
  kind: string;
  archivePath: string;
  originalSourcePath: string;
  restorePath: string;
  displayPath: string;
  conflict: boolean;
};

export type BackupRestoreResult = {
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  platform: string;
  dryRun: boolean;
  force: boolean;
  assets: RestoreAssetPlan[];
  restoredCount: number;
};

function buildPreRestoreSnapshotPath(targetPath: string, nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString().replaceAll(":", "-");
  return `${targetPath}.pre-restore-${timestamp}`;
}

// Verifies the manifest's declared sourcePath matches the absolute path
// derivable from the encoded archivePath. A tampered manifest could otherwise
// rewrite sourcePath to redirect writes to an unintended location while
// leaving archivePath valid.
function verifyAssetTargetIntegrity(asset: BackupManifestAsset, manifest: BackupManifest): void {
  const archiveRoot = manifest.archiveRoot.replace(/\/+$/u, "");
  const payloadPrefix = `${archiveRoot}/payload/`;
  if (!asset.archivePath.startsWith(payloadPrefix)) {
    throw new Error(`Backup manifest asset path is not under payload/: ${asset.archivePath}`);
  }
  const encoded = asset.archivePath.slice(payloadPrefix.length);
  const decoded = decodeAbsolutePathFromBackupArchive(encoded);
  if (decoded.absolutePath !== asset.sourcePath) {
    throw new Error(
      `Backup manifest asset sourcePath does not match archivePath encoding: sourcePath=${asset.sourcePath} encoded=${decoded.absolutePath}`,
    );
  }
}

export async function planRestore(opts: BackupRestoreOptions): Promise<BackupRestoreResult> {
  const archivePath = resolveUserPath(opts.archive);
  const { manifest } = await readBackupManifest(archivePath);

  if (manifest.assets.length === 0) {
    throw new Error("Backup archive declares no assets to restore.");
  }

  // Reject restores whose host platform does not exactly match the archive's.
  // Bucketing linux/darwin together as "posix" lets host-specific absolute
  // paths from one OS be written to another (e.g. linux /home/... onto macOS).
  if (manifest.platform !== "unknown" && manifest.platform !== process.platform) {
    throw new Error(
      `Archive was created on ${manifest.platform} but current platform is ${process.platform}. Cross-platform restore is not supported.`,
    );
  }

  const assets: RestoreAssetPlan[] = [];
  for (const asset of manifest.assets) {
    verifyAssetTargetIntegrity(asset, manifest);
    const restorePath = asset.sourcePath;
    const conflict = await pathExists(restorePath);
    assets.push({
      kind: asset.kind,
      archivePath: asset.archivePath,
      originalSourcePath: asset.sourcePath,
      restorePath,
      displayPath: shortenHomePath(restorePath),
      conflict,
    });
  }

  return {
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    platform: manifest.platform,
    dryRun: Boolean(opts.dryRun),
    force: Boolean(opts.force),
    assets,
    restoredCount: 0,
  };
}

async function statIfExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function restoreSingleAsset(params: {
  asset: RestoreAssetPlan;
  archivePath: string;
  force: boolean;
  nowMs: number;
}): Promise<void> {
  const { asset, archivePath, force, nowMs } = params;

  // Re-check conflict at execution time: the plan check happens earlier and
  // another process can create the path between plan and execute. Without a
  // fresh check, we'd skip the rename and overwrite without a snapshot.
  const conflictNow = await pathExists(asset.restorePath);
  const snapshotPath =
    conflictNow && force ? buildPreRestoreSnapshotPath(asset.restorePath, nowMs) : undefined;

  if (snapshotPath) {
    await fs.rename(asset.restorePath, snapshotPath);
  }

  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-"));

  try {
    const archivePrefix = asset.archivePath.endsWith("/")
      ? asset.archivePath
      : `${asset.archivePath}/`;

    // Extract matching entries to staging without strip so the asset lands at
    // exactly stagingDir/<asset.archivePath>. stat then tells us file vs dir.
    await tar.x({
      file: archivePath,
      cwd: stagingDir,
      gzip: true,
      filter: (entryPath) => entryPath === asset.archivePath || entryPath.startsWith(archivePrefix),
      preservePaths: false,
    });

    const stagedAssetPath = path.join(stagingDir, ...asset.archivePath.split("/"));
    const stagedStats = await statIfExists(stagedAssetPath);
    if (!stagedStats) {
      throw new Error(
        `No archive entries found for asset ${asset.kind} at ${asset.archivePath}. The archive may be corrupted or the manifest may not match the archive contents.`,
      );
    }

    await fs.mkdir(path.dirname(asset.restorePath), { recursive: true });

    if (stagedStats.isDirectory()) {
      await fs.mkdir(asset.restorePath, { recursive: true });
      const destinationRealDir = await prepareArchiveDestinationDir(asset.restorePath);
      await mergeExtractedTreeIntoDestination({
        sourceDir: stagedAssetPath,
        destinationDir: asset.restorePath,
        destinationRealDir,
      });
    } else if (stagedStats.isFile()) {
      await fs.copyFile(stagedAssetPath, asset.restorePath);
    } else {
      throw new Error(
        `Unsupported staged asset type for ${asset.kind} at ${asset.archivePath} (not file or directory).`,
      );
    }
  } catch (err) {
    if (snapshotPath) {
      await fs.rename(snapshotPath, asset.restorePath).catch(() => undefined);
    }
    throw new Error(
      `Failed to restore ${asset.displayPath}.${snapshotPath ? ` Original data preserved at: ${snapshotPath}` : ""}\n${String(err)}`,
      { cause: err },
    );
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function executeRestore(
  plan: BackupRestoreResult,
  opts: BackupRestoreOptions,
): Promise<number> {
  const nowMs = Date.now();
  let restoredCount = 0;

  for (const asset of plan.assets) {
    if (asset.conflict && !opts.force) {
      continue;
    }
    await restoreSingleAsset({
      asset,
      archivePath: plan.archivePath,
      force: Boolean(opts.force),
      nowMs,
    });
    restoredCount++;
  }

  return restoredCount;
}

export function formatBackupRestoreSummary(result: BackupRestoreResult): string[] {
  const lines = [`Backup archive: ${result.archivePath}`];
  lines.push(`Created at: ${result.createdAt}`);
  lines.push(`Runtime version: ${result.runtimeVersion}`);
  lines.push("");

  if (result.assets.length === 0) {
    lines.push("No assets to restore.");
    return lines;
  }

  lines.push(`Restore ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    const conflictTag = asset.conflict ? (result.force ? " (overwrite)" : " (conflict)") : "";
    lines.push(`- ${asset.kind}: ${asset.displayPath}${conflictTag}`);
  }

  if (result.dryRun) {
    lines.push("");
    lines.push("Dry run only; no files were written.");
    const conflicts = result.assets.filter((a) => a.conflict);
    if (conflicts.length > 0 && !result.force) {
      lines.push(
        `${conflicts.length} path${conflicts.length === 1 ? "" : "s"} already exist. Use --force to overwrite.`,
      );
    }
  } else {
    lines.push("");
    lines.push(`Restored ${result.restoredCount} path${result.restoredCount === 1 ? "" : "s"}.`);
    if (result.force) {
      const conflicts = result.assets.filter((a) => a.conflict);
      if (conflicts.length > 0) {
        lines.push(`Existing state saved with .pre-restore-* suffix before overwriting.`);
      }
    }
  }

  return lines;
}
