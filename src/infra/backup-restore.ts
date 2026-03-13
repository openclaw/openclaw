/**
 * Restore OpenClaw state from a backup archive (tar.gz) or manual backup directory.
 * Used by install script and `openclaw backup restore` CLI.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { resolveStateDir } from "../config/paths.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

export type BackupRestoreOptions = {
  /** Path to .tar.gz archive or directory (manual backup with skills/, sessions/, etc.) */
  source: string;
  /** Target state directory (default: resolveStateDir()) */
  targetDir?: string;
  /** Verify archive before restore (tar.gz only) */
  verify?: boolean;
  /** Dry run: print plan, do not write */
  dryRun?: boolean;
};

export type BackupRestoreResult = {
  restored: string[];
  targetDir: string;
  sourceType: "tar" | "manual";
};

async function isTarArchive(sourcePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(sourcePath);
    return stat.isFile() && sourcePath.endsWith(".tar.gz");
  } catch {
    return false;
  }
}

async function isManualBackupDir(sourcePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isDirectory()) {
      return false;
    }
    const entries = await fs.readdir(sourcePath);
    const hasSkills = entries.includes("skills");
    const hasSessions = entries.includes("sessions");
    const hasConfig =
      entries.includes("openclaw.json") ||
      entries.some((e) => e.endsWith(".json") && e.includes("claw"));
    return hasSkills || hasSessions || hasConfig;
  } catch {
    return false;
  }
}

async function findTarInDir(dirPath: string): Promise<string | null> {
  const entries = await fs.readdir(dirPath);
  const tars = entries.filter((e) => e.endsWith(".tar.gz"));
  if (tars.length === 0) {
    return null;
  }
  tars.toSorted().reverse();
  return path.join(dirPath, tars[0]);
}

async function restoreFromTar(
  archivePath: string,
  targetDir: string,
  opts: { verify?: boolean; dryRun?: boolean },
  runtime: RuntimeEnv,
): Promise<BackupRestoreResult> {
  const resolvedArchive = resolveUserPath(archivePath);

  if (opts.verify) {
    await backupVerifyCommand(
      { ...runtime, log: () => {} },
      { archive: resolvedArchive, json: false },
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
  try {
    await tar.x({
      file: resolvedArchive,
      gzip: true,
      cwd: tempDir,
    });

    const entries = await fs.readdir(tempDir);
    const archiveRoot = entries[0];
    if (!archiveRoot) {
      throw new Error("Archive is empty or has unexpected structure.");
    }
    const manifestPath = path.join(tempDir, archiveRoot, "manifest.json");
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      schemaVersion: number;
      archiveRoot: string;
      paths?: { stateDir?: string };
      assets: Array<{ kind: string; sourcePath: string; archivePath: string }>;
    };

    if (manifest.schemaVersion !== 1) {
      throw new Error(`Unsupported backup manifest schemaVersion: ${manifest.schemaVersion}`);
    }

    const oldStateDir =
      manifest.paths?.stateDir ?? path.dirname(manifest.assets[0]?.sourcePath ?? "");
    const restored: string[] = [];

    for (const asset of manifest.assets) {
      const extractedPath = path.join(tempDir, asset.archivePath);
      try {
        await fs.access(extractedPath);
      } catch {
        continue;
      }

      const relativeToOld = path.relative(oldStateDir, asset.sourcePath);
      const targetPath =
        relativeToOld && !relativeToOld.startsWith("..")
          ? path.join(targetDir, relativeToOld)
          : targetDir;

      if (opts.dryRun) {
        runtime.log(`Would restore: ${asset.kind} -> ${targetPath}`);
        restored.push(targetPath);
        continue;
      }

      const stat = await fs.stat(extractedPath);
      if (stat.isDirectory()) {
        const destDir = targetPath === targetDir ? targetDir : path.dirname(targetPath);
        await fs.mkdir(destDir, { recursive: true });
        const entries = await fs.readdir(extractedPath);
        for (const entry of entries) {
          const src = path.join(extractedPath, entry);
          const dest = path.join(
            targetDir,
            path.relative(oldStateDir, path.join(asset.sourcePath, entry)),
          );
          await fs.mkdir(path.dirname(dest), { recursive: true });
          const entryStat = await fs.stat(src);
          if (entryStat.isDirectory()) {
            await fs.cp(src, dest, { recursive: true });
          } else {
            await fs.cp(src, dest);
          }
          restored.push(dest);
        }
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.cp(extractedPath, targetPath);
        restored.push(targetPath);
      }
    }

    return { restored, targetDir, sourceType: "tar" };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreFromManual(
  sourceDir: string,
  targetDir: string,
  opts: { dryRun?: boolean },
  runtime: RuntimeEnv,
): Promise<BackupRestoreResult> {
  const resolvedSource = resolveUserPath(sourceDir);
  const restored: string[] = [];

  const toCopy = ["skills", "sessions", "credentials", "openclaw.json"];
  for (const name of toCopy) {
    const src = path.join(resolvedSource, name);
    try {
      await fs.access(src);
    } catch {
      continue;
    }

    const dest = path.join(targetDir, name);
    if (opts.dryRun) {
      runtime.log(`Would restore: ${name} -> ${dest}`);
      restored.push(dest);
      continue;
    }

    await fs.mkdir(targetDir, { recursive: true });
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      await fs.cp(src, dest, { recursive: true });
    } else {
      await fs.cp(src, dest);
    }
    restored.push(dest);
  }

  return { restored, targetDir, sourceType: "manual" };
}

/**
 * Restore OpenClaw state from a backup.
 * Supports both tar.gz archives and manual backup directories.
 */
export async function restoreBackup(
  runtime: RuntimeEnv,
  opts: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const source = resolveUserPath(opts.source);
  const targetDir = opts.targetDir ? resolveUserPath(opts.targetDir) : resolveStateDir();

  const stat = await fs.stat(source).catch(() => null);
  if (!stat) {
    throw new Error(`Backup source not found: ${source}`);
  }

  if (stat.isDirectory()) {
    const tarPath = await findTarInDir(source);
    if (tarPath) {
      return restoreFromTar(
        tarPath,
        targetDir,
        { verify: opts.verify, dryRun: opts.dryRun },
        runtime,
      );
    }
    if (await isManualBackupDir(source)) {
      return restoreFromManual(source, targetDir, { dryRun: opts.dryRun }, runtime);
    }
    throw new Error(`Directory is not a valid backup: ${source}`);
  }

  if (await isTarArchive(source)) {
    return restoreFromTar(source, targetDir, { verify: opts.verify, dryRun: opts.dryRun }, runtime);
  }

  throw new Error(`Unsupported backup format: ${source}`);
}
