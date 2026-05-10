import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath, resolveUserPath } from "../utils.js";
import { verifyBackupArchive } from "./backup-verify.js";

export type BackupRestoreOptions = {
  archive: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
};

export type BackupRestoreResult = {
  archivePath: string;
  archiveRoot: string;
  dryRun: boolean;
  verified: true;
  restoredAssets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
    status: "planned" | "restored";
  }>;
  databaseSnapshotCount: number;
};

function extractedArchivePath(tempDir: string, archivePath: string): string {
  return path.join(tempDir, ...archivePath.split("/"));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function replacePathFromExtracted(params: {
  extractedPath: string;
  targetPath: string;
}): Promise<void> {
  const targetPath = path.resolve(params.targetPath);
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const stagingPath = path.join(parentDir, `.${path.basename(targetPath)}.${randomUUID()}.restore`);
  const oldPath = `${stagingPath}.old`;
  await fs.rm(stagingPath, { recursive: true, force: true });
  await fs.cp(params.extractedPath, stagingPath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const hadExisting = await pathExists(targetPath);
  try {
    if (hadExisting) {
      await fs.rename(targetPath, oldPath);
    }
    await fs.rename(stagingPath, targetPath);
    if (hadExisting) {
      await fs.rm(oldPath, { recursive: true, force: true });
    }
  } catch (err) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (hadExisting && !(await pathExists(targetPath)) && (await pathExists(oldPath))) {
      await fs.rename(oldPath, targetPath).catch(() => undefined);
    }
    throw err;
  }
}

function formatBackupRestoreSummary(result: BackupRestoreResult): string[] {
  const lines = [
    `Backup archive: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Database snapshots: ${result.databaseSnapshotCount}`,
  ];
  lines.push(
    `${result.dryRun ? "Would restore" : "Restored"} ${result.restoredAssets.length} path${
      result.restoredAssets.length === 1 ? "" : "s"
    }:`,
  );
  for (const asset of result.restoredAssets) {
    lines.push(`- ${asset.kind}: ${shortenHomePath(asset.sourcePath)}`);
  }
  if (result.dryRun) {
    lines.push("Dry run only; no files were changed.");
  }
  return lines;
}

export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult | undefined> {
  const archivePath = resolveUserPath(opts.archive);
  const dryRun = Boolean(opts.dryRun);
  if (!dryRun && !opts.yes) {
    runtime.error("Backup restore requires --yes. Preview first with --dry-run.");
    runtime.exit(1);
    return undefined;
  }

  const verified = await verifyBackupArchive({ archive: archivePath });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-restore-"));
  try {
    await tar.x({
      file: archivePath,
      gzip: true,
      cwd: tempDir,
    });
    const { manifest } = verified;
    const restoredAssets: BackupRestoreResult["restoredAssets"] = [];
    for (const asset of manifest.assets) {
      const extractedPath = extractedArchivePath(tempDir, asset.archivePath);
      await fs.access(extractedPath);
      restoredAssets.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        archivePath: asset.archivePath,
        status: dryRun ? "planned" : "restored",
      });
      if (!dryRun) {
        await replacePathFromExtracted({
          extractedPath,
          targetPath: asset.sourcePath,
        });
      }
    }

    const result: BackupRestoreResult = {
      archivePath,
      archiveRoot: verified.result.archiveRoot,
      dryRun,
      verified: true,
      restoredAssets,
      databaseSnapshotCount: manifest.databaseSnapshots?.length ?? 0,
    };
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupRestoreSummary(result).join("\n"));
    }
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
