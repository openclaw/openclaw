import path from "node:path";

export const CONFIG_BACKUP_COUNT = 5;

/** Matches datetime-stamped backup suffixes: YYYYMMDD-HHmmssSSS (UTC) */
export const BACKUP_DATETIME_RE = /^\d{8}-\d{9}$/;

/**
 * Format a Date as a UTC datetime suffix for backup filenames.
 * Output: YYYYMMDD-HHmmssSSS — lexicographically sortable, millisecond precision
 * to avoid collisions on rapid successive writes.
 */
export function formatBackupTimestamp(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${y}${mo}${d}-${h}${mi}${s}${ms}`;
}

export interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
}

export interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
  // readdir is required so orphan cleanup and permission hardening can scan the dir
  readdir: (path: string) => Promise<string[]>;
}

/**
 * Rotate config backups by renaming the primary .bak to a datetime-stamped file.
 * The timestamp (YYYYMMDD-HHmmssSSS, UTC) makes it immediately clear when each
 * backup was taken, which is more useful for recovery than a relative sequence number.
 */
export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
  now = new Date(),
): Promise<void> {
  const backupBase = `${configPath}.bak`;
  const timestamp = formatBackupTimestamp(now);
  await ioFs.rename(backupBase, `${backupBase}.${timestamp}`).catch(() => {
    // best-effort — .bak may not exist on first run
  });
}

/**
 * Harden file permissions on .bak and all datetime-stamped .bak.* files.
 * copyFile does not guarantee permission preservation on all platforms
 * (e.g. Windows, some NFS mounts), so we explicitly chmod each backup
 * to owner-only (0o600) to match the main config file.
 */
export async function hardenBackupPermissions(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.chmod) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  // Harden the primary .bak
  await ioFs.chmod(backupBase, 0o600).catch(() => {
    // best-effort
  });

  if (!ioFs.readdir) {
    return;
  }
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const bakPrefix = `${base}.bak.`;

  let entries: string[];
  try {
    entries = await ioFs.readdir(dir);
  } catch {
    return; // best-effort
  }

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (!BACKUP_DATETIME_RE.test(suffix)) {
      continue;
    }
    await ioFs.chmod(path.join(dir, entry), 0o600).catch(() => {
      // best-effort
    });
  }
}

/**
 * Remove orphan .bak files that fall outside the managed rotation.
 *
 * - Non-datetime .bak.* files are treated as orphans and deleted. This includes
 *   legacy numeric backups (.bak.1–.bak.4), PID-stamped files (.bak.1772352289),
 *   and manual copies (.bak.before-marketing).
 * - Datetime-stamped backups beyond the CONFIG_BACKUP_COUNT - 1 most recent are
 *   also deleted. Datetime format is lexicographically sortable so no mtime reads
 *   are needed.
 *
 * Only the primary .bak (no suffix) is never touched here.
 */
export async function cleanOrphanBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (!ioFs.readdir) {
    return;
  }
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const bakPrefix = `${base}.bak.`;

  let entries: string[];
  try {
    entries = await ioFs.readdir(dir);
  } catch {
    return; // best-effort
  }

  const datetimeBackups: string[] = [];

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (BACKUP_DATETIME_RE.test(suffix)) {
      datetimeBackups.push(entry);
    } else {
      // Non-datetime suffix — orphan (legacy numeric, PID-stamped, manual copy)
      await ioFs.unlink(path.join(dir, entry)).catch(() => {
        // best-effort
      });
    }
  }

  // Keep only the CONFIG_BACKUP_COUNT - 1 most recent datetime backups.
  // The format is lexicographically sortable (YYYYMMDD-HHmmssSSS), so a
  // string sort gives chronological order without reading file metadata.
  // toSorted returns a new array; assign it so the slice below uses the sorted order
  const sortedBackups = datetimeBackups.toSorted().toReversed(); // descending: most recent first
  const toDelete = sortedBackups.slice(CONFIG_BACKUP_COUNT - 1);
  for (const entry of toDelete) {
    await ioFs.unlink(path.join(dir, entry)).catch(() => {
      // best-effort
    });
  }
}

/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: rotate ring -> create new .bak -> harden modes -> prune backups.
 */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs,
  now = new Date(),
): Promise<void> {
  await rotateConfigBackups(configPath, ioFs, now);
  await ioFs.copyFile(configPath, `${configPath}.bak`).catch(() => {
    // best-effort
  });
  await hardenBackupPermissions(configPath, ioFs);
  await cleanOrphanBackups(configPath, ioFs);
}
