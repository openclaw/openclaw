import os from "node:os";
import path from "node:path";

export const CONFIG_BACKUP_COUNT = 5;

export interface BackupConfig {
  path?: string;
  maxFiles?: number;
  trigger?: "write" | "interact";
}

export interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
}

export interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<void>;
}

/**
 * Get the effective backup count from config (with default).
 */
export function getBackupCount(config?: BackupConfig): number {
  return config?.maxFiles ?? CONFIG_BACKUP_COUNT;
}

/**
 * Get the effective backup path from config.
 * If not configured, returns the directory of the config file.
 */
export function getBackupPath(configPath: string, config?: BackupConfig): string {
  if (config?.path) {
    // Replace all occurrences of ~ with homedir (not just the first)
    return path.resolve(config.path.replace(/^~/, os.homedir()));
  }
  // Default: same directory as config file
  return path.dirname(configPath);
}

/**
 * Build the backup filename with optional custom path.
 */
export function buildBackupPath(baseDir: string, configPath: string, suffix: string = ""): string {
  const baseName = path.basename(configPath);
  return path.join(baseDir, `${baseName}.bak${suffix}`);
}

export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
  config?: BackupConfig,
): Promise<void> {
  const backupCount = getBackupCount(config);
  if (backupCount <= 1) {
    return;
  }

  const backupDir = getBackupPath(configPath, config);
  const backupBase = buildBackupPath(backupDir, configPath);

  const maxIndex = backupCount - 1;
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    // best-effort
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      // best-effort
    });
  }
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    // best-effort
  });
}

/**
 * Harden file permissions on all .bak files in the rotation ring.
 * copyFile does not guarantee permission preservation on all platforms
 * (e.g. Windows, some NFS mounts), so we explicitly chmod each backup
 * to owner-only (0o600) to match the main config file.
 */
export async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
  config?: BackupConfig,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }

  const backupCount = getBackupCount(config);
  const backupDir = getBackupPath(configPath, config);
  const backupBase = buildBackupPath(backupDir, configPath);

  // Harden the primary .bak
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    // best-effort
  });
  // Harden numbered backups
  for (let i = 1; i < backupCount; i++) {
    await ioFs.chmod(`${backupBase}.${i}`, 0o600).catch(() => {
      // best-effort
    });
  }
}

/**
 * Remove orphan .bak files that fall outside the managed rotation ring.
 * These can accumulate from interrupted writes, manual copies, or PID-stamped
 * backups (e.g. openclaw.json.bak.1772352289, openclaw.json.bak.before-marketing).
 *
 * Only files matching `<configBasename>.bak.*` are considered; the primary
 * `.bak` and numbered `.bak.1` through `.bak.{N-1}` are preserved.
 */
export async function cleanOrphanBackups(
  configPath: string,
  ioFs: BackupRotationFs,
  config?: BackupConfig,
): Promise<void> {
  if (!ioFs.readdir) {
    return;
  }

  const backupCount = getBackupCount(config);
  const backupDir = getBackupPath(configPath, config);
  const baseName = path.basename(configPath);
  const bakPrefix = `${baseName}.bak.`;

  // Build the set of valid numbered suffixes: "1", "2", ..., "{N-1}"
  const validSuffixes = new Set<string>();
  for (let i = 1; i < backupCount; i++) {
    validSuffixes.add(String(i));
  }

  let entries: string[];
  try {
    entries = await ioFs.readdir(backupDir);
  } catch {
    return; // best-effort
  }

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (validSuffixes.has(suffix)) {
      continue;
    }
    // This is an orphan — remove it
    await ioFs.unlink(path.join(backupDir, entry)).catch(() => {
      // best-effort
    });
  }
}

/**
 * Check if backup should be triggered based on config.
 * - "write" (default): Backup on every config write
 * - "interact": Backup on user interaction (requires external trigger)
 */
export function shouldTriggerBackup(config?: BackupConfig): boolean {
  // Default to "write" behavior if not specified
  const trigger = config?.trigger ?? "write";
  // For "write" trigger, we always backup on write
  // For "interact" trigger, backup is handled by interaction hooks
  return trigger === "write";
}

/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: ensure dir -> rotate ring -> create new .bak -> harden modes -> prune orphan .bak.* files.
 */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs,
  config?: BackupConfig,
): Promise<void> {
  // Check if we should trigger backup based on config
  if (!shouldTriggerBackup(config)) {
    return;
  }

  const backupDir = getBackupPath(configPath, config);

  // Ensure backup directory exists (best-effort)
  if (ioFs.mkdir) {
    try {
      await ioFs.mkdir(backupDir, { recursive: true });
    } catch {
      // Directory may already exist or creation failed - continue best-effort
    }
  }

  await rotateConfigBackups(configPath, ioFs, config);

  const backupBase = buildBackupPath(backupDir, configPath);
  await ioFs.copyFile(configPath, backupBase).catch(() => {
    // best-effort
  });
  await hardenBackupPermissions(configPath, ioFs, config);
  await cleanOrphanBackups(configPath, ioFs, config);
}
