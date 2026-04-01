import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import {
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
} from "./archive-staging.js";
import { type BackupManifest } from "./backup-archive-read.js";
import {
  extractManifest,
  isRootManifestEntry,
  listArchiveEntries,
  normalizeArchivePath,
  parseManifest,
} from "./backup-archive-read.js";

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

async function readManifestFromArchive(archivePath: string): Promise<BackupManifest> {
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry,
    normalized: normalizeArchivePath(entry, "Archive entry"),
  }));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }

  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  return parseManifest(manifestRaw);
}

export async function planRestore(opts: BackupRestoreOptions): Promise<BackupRestoreResult> {
  const archivePath = resolveUserPath(opts.archive);
  const manifest = await readManifestFromArchive(archivePath);

  // Cross-platform check
  const currentPlatform = process.platform === "win32" ? "win32" : "posix";
  const archivePlatform =
    manifest.platform === "win32" ? "win32" : manifest.platform === "unknown" ? "unknown" : "posix";
  if (archivePlatform !== "unknown" && archivePlatform !== currentPlatform) {
    throw new Error(
      `Archive was created on ${manifest.platform} but current platform is ${process.platform}. Cross-platform restore is not supported.`,
    );
  }

  const assets: RestoreAssetPlan[] = [];
  for (const asset of manifest.assets) {
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

    // If conflict exists and force is set, rename the existing path as a safety backup
    if (asset.conflict && opts.force) {
      const snapshotPath = buildPreRestoreSnapshotPath(asset.restorePath, nowMs);
      await fs.rename(asset.restorePath, snapshotPath);
    }

    // Calculate strip depth: number of path segments in asset.archivePath
    // e.g. "2026-04-01T21-43-12.355Z-openclaw-backup/payload/posix/home/coder/.openclaw"
    // We need to strip all segments except the actual content, so we extract to a
    // staging dir and then merge into the restore target.
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-"));

    try {
      // Extract matching entries into staging dir, stripping the archive prefix
      const archivePrefix = asset.archivePath.endsWith("/")
        ? asset.archivePath
        : `${asset.archivePath}/`;
      const stripDepth = asset.archivePath.split("/").length;

      await tar.x({
        file: plan.archivePath,
        cwd: stagingDir,
        gzip: true,
        strip: stripDepth,
        filter: (entryPath) => {
          return entryPath === asset.archivePath || entryPath.startsWith(archivePrefix);
        },
        preservePaths: false,
      });

      // Ensure restore target parent directory exists
      await fs.mkdir(path.dirname(asset.restorePath), { recursive: true });

      // Check if staging dir has content
      const stagingEntries = await fs.readdir(stagingDir);
      if (stagingEntries.length === 0) {
        continue;
      }

      // Ensure restore target directory exists
      await fs.mkdir(asset.restorePath, { recursive: true });
      const destinationRealDir = await prepareArchiveDestinationDir(asset.restorePath);

      await mergeExtractedTreeIntoDestination({
        sourceDir: stagingDir,
        destinationDir: asset.restorePath,
        destinationRealDir,
      });

      restoredCount++;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
