import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { ensureDirForFile, isRecord } from "../shared.js";
import type { BackupManifest } from "./types.js";

export const BACKUP_DIRNAME = "secrets-migrate";
export const BACKUP_MANIFEST_FILENAME = "manifest.json";
export const BACKUP_RETENTION = 20;

export function resolveBackupRoot(stateDir: string): string {
  return path.join(resolveUserPath(stateDir), "backups", BACKUP_DIRNAME);
}

function formatBackupId(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

export function resolveUniqueBackupId(stateDir: string, now: Date): string {
  const backupRoot = resolveBackupRoot(stateDir);
  const base = formatBackupId(now);
  let candidate = base;
  let attempt = 0;

  while (fs.existsSync(path.join(backupRoot, candidate))) {
    attempt += 1;
    const suffix = `${String(attempt).padStart(2, "0")}-${crypto.randomBytes(2).toString("hex")}`;
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}

export function createBackupManifest(params: {
  stateDir: string;
  targets: string[];
  backupId: string;
  now: Date;
}): { backupDir: string; manifestPath: string; manifest: BackupManifest } {
  const backupDir = path.join(resolveBackupRoot(params.stateDir), params.backupId);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const entries: BackupManifest["entries"] = [];
  let index = 0;
  for (const target of params.targets) {
    const normalized = resolveUserPath(target);
    const exists = fs.existsSync(normalized);
    if (!exists) {
      entries.push({ path: normalized, existed: false });
      continue;
    }

    const backupName = `file-${String(index).padStart(4, "0")}.bak`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(normalized, backupPath);
    const stats = fs.statSync(normalized);
    entries.push({
      path: normalized,
      existed: true,
      backupPath,
      mode: stats.mode & 0o777,
    });
    index += 1;
  }

  const manifest: BackupManifest = {
    version: 1,
    backupId: params.backupId,
    createdAt: params.now.toISOString(),
    entries,
  };
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.chmodSync(manifestPath, 0o600);

  return { backupDir, manifestPath, manifest };
}

export function restoreFromManifest(manifest: BackupManifest): {
  restoredFiles: number;
  deletedFiles: number;
} {
  let restoredFiles = 0;
  let deletedFiles = 0;

  for (const entry of manifest.entries) {
    if (!entry.existed) {
      if (fs.existsSync(entry.path)) {
        fs.rmSync(entry.path, { force: true });
        deletedFiles += 1;
      }
      continue;
    }

    if (!entry.backupPath || !fs.existsSync(entry.backupPath)) {
      throw new Error(`Backup file is missing for ${entry.path}.`);
    }
    ensureDirForFile(entry.path);
    fs.copyFileSync(entry.backupPath, entry.path);
    fs.chmodSync(entry.path, entry.mode ?? 0o600);
    restoredFiles += 1;
  }

  return { restoredFiles, deletedFiles };
}

export function pruneOldBackups(stateDir: string): void {
  const backupRoot = resolveBackupRoot(stateDir);
  if (!fs.existsSync(backupRoot)) {
    return;
  }
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  if (dirs.length <= BACKUP_RETENTION) {
    return;
  }

  const toDelete = dirs.slice(0, Math.max(0, dirs.length - BACKUP_RETENTION));
  for (const dir of toDelete) {
    fs.rmSync(path.join(backupRoot, dir), { recursive: true, force: true });
  }
}

export function resolveSecretsMigrationBackupRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBackupRoot(resolveStateDir(env, os.homedir));
}

export function listSecretsMigrationBackups(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = resolveSecretsMigrationBackupRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

export function readBackupManifest(params: {
  backupId: string;
  env: NodeJS.ProcessEnv;
}): BackupManifest {
  const backupDir = path.join(resolveSecretsMigrationBackupRoot(params.env), params.backupId);
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    const available = listSecretsMigrationBackups(params.env);
    const suffix =
      available.length > 0
        ? ` Available backups: ${available.slice(-10).join(", ")}`
        : " No backups were found.";
    throw new Error(`Backup "${params.backupId}" was not found.${suffix}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Failed to read backup manifest at ${manifestPath}: ${String(err)}`, {
      cause: err,
    });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    throw new Error(`Backup manifest at ${manifestPath} is invalid.`);
  }

  return parsed as BackupManifest;
}
