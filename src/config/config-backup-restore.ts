/**
 * Config backup and restore utilities for OpenClaw gateway.
 *
 * This module provides:
 * - Automatic backup creation before config changes
 * - Manual backup creation
 * - Backup listing and restoration
 * - Automatic rollback on gateway startup failure
 */

import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_KEEP_BACKUPS = 10;

export interface ConfigBackupOptions {
  keepBackups?: number;
  timestamp?: boolean;
  label?: string;
}

export interface ConfigBackup {
  path: string;
  timestamp: Date;
  size: number;
  label?: string;
}

export interface BackupRestoreFs {
  copyFile: (from: string, to: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  stat: (path: string) => Promise<{ size: number; mtime: Date }>;
  readdir: (path: string) => Promise<string[]>;
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
}

const defaultFs: BackupRestoreFs = {
  copyFile: async (from, to) => fs.copyFile(from, to),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  writeFile: async (path, data) => fs.writeFile(path, data, "utf-8"),
  stat: async (path) => {
    const stats = await fs.stat(path);
    return { size: stats.size, mtime: stats.mtime };
  },
  readdir: async (path) => fs.readdir(path),
  unlink: async (path) => fs.unlink(path),
  rename: async (from, to) => fs.rename(from, to),
};

/**
 * List all available config backups.
 */
export async function listConfigBackups(
  configPath: string,
  ioFs: BackupRestoreFs = defaultFs,
): Promise<ConfigBackup[]> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const backups: ConfigBackup[] = [];

  // Check primary .bak file
  const primaryBak = `${configPath}.bak`;
  try {
    const stat = await ioFs.stat(primaryBak);
    backups.push({
      path: primaryBak,
      timestamp: stat.mtime,
      size: stat.size,
      label: "latest",
    });
  } catch {
    // Primary backup doesn't exist
  }

  // Check numbered and timestamped backups
  try {
    const entries = await ioFs.readdir(dir);
    for (const entry of entries) {
      // Match both numbered backups (.bak.1, .bak.2) and timestamped backups (.bak.2024-01-15_00-00-00)
      // Exclude failed backups (.failed-*)
      const match = entry.match(new RegExp(`^${base}\\.bak\\.(.+)$`));
      if (match && !entry.includes(".failed-")) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = await ioFs.stat(fullPath);
          backups.push({
            path: fullPath,
            timestamp: stat.mtime,
            size: stat.size,
            label: `backup-${match[1]}`,
          });
        } catch {
          // Skip unreadable backups
        }
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  // Sort by timestamp, newest first
  backups.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return backups;
}

/**
 * Create a manual backup with optional label.
 */
export async function createConfigBackup(
  configPath: string,
  options: ConfigBackupOptions = {},
  ioFs: BackupRestoreFs = defaultFs,
): Promise<ConfigBackup> {
  const dir = path.dirname(configPath);
  const keepBackups = options.keepBackups ?? DEFAULT_KEEP_BACKUPS;

  // Ensure backup directory exists
  try {
    await ioFs.readdir(dir);
  } catch {
    throw new Error(`Config directory does not exist: ${dir}`);
  }

  // Read current config
  let configContent: string;
  try {
    configContent = await ioFs.readFile(configPath);
  } catch (err) {
    throw new Error(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }

  // Create timestamped backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const label = options.label ? `-${options.label.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const backupPath = options.timestamp
    ? `${configPath}.bak.${timestamp}${label}`
    : `${configPath}.bak`;

  await fs.writeFile(backupPath, configContent, { mode: 0o600 });

  // Prune old backups if keepBackups is set
  if (keepBackups > 0) {
    await pruneOldBackups(configPath, keepBackups, ioFs);
  }

  const stat = await ioFs.stat(backupPath);
  return {
    path: backupPath,
    timestamp: stat.mtime,
    size: stat.size,
    label: options.label || (options.timestamp ? timestamp : "latest"),
  };
}

/**
 * Prune old backups, keeping only the most recent N backups.
 */
async function pruneOldBackups(
  configPath: string,
  keepBackups: number,
  ioFs: BackupRestoreFs,
): Promise<void> {
  const backups = await listConfigBackups(configPath, ioFs);

  // Keep the primary .bak file plus (keepBackups - 1) numbered/timestamped backups
  // The primary .bak is always kept as the most recent automatic backup
  const backupsToPrune = backups.slice(keepBackups);

  for (const backup of backupsToPrune) {
    try {
      await ioFs.unlink(backup.path);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Restore config from the latest backup or a specific backup.
 */
export async function restoreConfigBackup(
  configPath: string,
  options: { backupPath?: string; dryRun?: boolean } = {},
  ioFs: BackupRestoreFs = defaultFs,
): Promise<{ success: boolean; backupPath: string; error?: string }> {
  // Determine backup path
  const backupPath = options.backupPath || `${configPath}.bak`;
  const isExplicitPath = options.backupPath !== undefined;

  // Check if backup exists
  try {
    await ioFs.stat(backupPath);
  } catch {
    // If user explicitly requested a specific backup path, fail immediately
    if (isExplicitPath) {
      return {
        success: false,
        backupPath,
        error: `Backup not found: ${backupPath}`,
      };
    }

    // For default path, try numbered backups as fallback
    const backups = await listConfigBackups(configPath, ioFs);
    if (backups.length === 0) {
      return {
        success: false,
        backupPath,
        error: "No backup found",
      };
    }
    // Use the newest backup
    const newest = backups[0];
    return restoreConfigBackup(
      configPath,
      { backupPath: newest.path, dryRun: options.dryRun },
      ioFs,
    );
  }

  if (options.dryRun) {
    return { success: true, backupPath };
  }

  // Create a backup of current config before restore (safety)
  const currentBackup = `${configPath}.failed-${Date.now()}`;
  try {
    await ioFs.copyFile(configPath, currentBackup);
  } catch {
    // Current config may not exist, continue
  }

  // Restore from backup
  try {
    const content = await ioFs.readFile(backupPath);
    await ioFs.writeFile(configPath, content);
    return { success: true, backupPath };
  } catch (err) {
    return {
      success: false,
      backupPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Attempt to restore from backup if config validation fails.
 * Returns the restored config content, or null if no backup available.
 */
export async function attemptConfigRollback(
  configPath: string,
  ioFs: BackupRestoreFs = defaultFs,
): Promise<{ restored: boolean; backupPath?: string; error?: string }> {
  const backups = await listConfigBackups(configPath, ioFs);

  if (backups.length === 0) {
    return {
      restored: false,
      error: "No backup found for rollback",
    };
  }

  // Try each backup in order (newest first)
  for (const backup of backups) {
    try {
      const content = await ioFs.readFile(backup.path);

      // Validate the backup content is valid JSON
      try {
        JSON.parse(content);
      } catch {
        continue; // Skip invalid backups
      }

      // Backup current failed config
      const failedBackup = `${configPath}.failed-${Date.now()}`;
      try {
        await ioFs.copyFile(configPath, failedBackup);
      } catch {
        // Current config may not exist
      }

      // Restore from backup
      await ioFs.writeFile(configPath, content);

      return {
        restored: true,
        backupPath: backup.path,
      };
    } catch {
      continue;
    }
  }

  return {
    restored: false,
    error: "No valid backup found for rollback",
  };
}

/**
 * Clean up old failed config backups.
 */
export async function cleanupFailedBackups(
  configPath: string,
  maxAge: number = 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  ioFs: BackupRestoreFs = defaultFs,
): Promise<number> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const cutoff = Date.now() - maxAge;
  let cleaned = 0;

  try {
    const entries = await ioFs.readdir(dir);
    for (const entry of entries) {
      if (entry.match(new RegExp(`^${base}\\.failed-\\d+$`))) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = await ioFs.stat(fullPath);
          if (stat.mtime.getTime() < cutoff) {
            await ioFs.unlink(fullPath);
            cleaned++;
          }
        } catch {
          // Skip if can't stat or delete
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }

  return cleaned;
}

/**
 * Get backup statistics.
 */
export async function getBackupStats(
  configPath: string,
  ioFs: BackupRestoreFs = defaultFs,
): Promise<{
  totalBackups: number;
  totalSize: number;
  oldestBackup?: Date;
  newestBackup?: Date;
}> {
  const backups = await listConfigBackups(configPath, ioFs);

  return {
    totalBackups: backups.length,
    totalSize: backups.reduce((sum, b) => sum + b.size, 0),
    oldestBackup: backups.length > 0 ? backups[backups.length - 1].timestamp : undefined,
    newestBackup: backups.length > 0 ? backups[0].timestamp : undefined,
  };
}
