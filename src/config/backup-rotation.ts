import path from "node:path";

export const CONFIG_BACKUP_COUNT = 5;

export interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readdir: (path: string) => Promise<string[]>;
}

export interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
}

/** YYYYMMDD-HHmmss in UTC. */
function formatBackupTimestamp(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Pattern that matches a datetime suffix: YYYYMMDD-HHmmss with optional
 * zero-padded collision suffix (-02, -03, …). The collision counter starts
 * at 02, so -0 and -1 are never produced and are intentionally excluded.
 */
const DATETIME_SUFFIX_RE = /^\d{8}-\d{6}(?:-\d{2,})?$/;

/** Check whether a suffix looks like a datetime backup suffix. */
export function isDatetimeSuffix(suffix: string): boolean {
  return DATETIME_SUFFIX_RE.test(suffix);
}

/**
 * Rotate the primary `.bak` file into a datetime-stamped slot.
 *
 * Previous behavior used numeric rotation (.bak.1, .bak.2, …).
 * Now we rename `.bak` → `.bak.YYYYMMDD-HHmmss` and rely on
 * {@link cleanOrphanBackups} to enforce the capacity limit.
 */
export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const stamp = formatBackupTimestamp();
  let dest = `${backupBase}.${stamp}`;

  // Handle sub-second collision: append zero-padded -02, -03, … suffix.
  const dir = path.dirname(configPath);
  const entries = await ioFs.readdir(dir).catch(() => [] as string[]);
  const destBasename = path.basename(dest);
  if (entries.includes(destBasename)) {
    let seq = 2;
    while (entries.includes(`${destBasename}-${String(seq).padStart(2, "0")}`)) {
      seq += 1;
    }
    dest = `${dest}-${String(seq).padStart(2, "0")}`;
  }

  await ioFs.rename(backupBase, dest).catch(() => {
    // best-effort — .bak may not exist yet
  });
}

/**
 * Harden file permissions on all .bak files.
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
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const bakExact = `${base}.bak`;

  // Harden the primary .bak
  await ioFs.chmod(`${configPath}.bak`, 0o600).catch(() => {
    // best-effort
  });

  // Harden all datetime-stamped backups
  const entries = await ioFs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(`${bakExact}.`)) {
      continue;
    }
    const suffix = entry.slice(bakExact.length + 1);
    if (isDatetimeSuffix(suffix)) {
      await ioFs.chmod(path.join(dir, entry), 0o600).catch(() => {
        // best-effort
      });
    }
  }
}

/**
 * Remove backup files that fall outside the managed rotation ring.
 *
 * Keeps the N-1 most recent datetime-stamped backups (sorted lexicographically,
 * which equals chronological order for the YYYYMMDD-HHmmss format).
 *
 * Also removes legacy numbered backups (.bak.1, .bak.2, …) and any other
 * non-datetime orphans (PID-stamped, manual copies, etc.).
 */
export async function cleanOrphanBackups(
  configPath: string,
  ioFs: BackupRotationFs,
): Promise<void> {
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
  const orphans: string[] = [];

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (isDatetimeSuffix(suffix)) {
      datetimeBackups.push(entry);
    } else {
      orphans.push(entry);
    }
  }

  // Remove all non-datetime orphans (legacy numbered, PID-stamped, manual, etc.)
  for (const orphan of orphans) {
    await ioFs.unlink(path.join(dir, orphan)).catch(() => {
      // best-effort
    });
  }

  // Keep the N-1 most recent datetime backups, remove the rest.
  // (N-1 because the primary .bak also counts toward CONFIG_BACKUP_COUNT.)
  const maxDatetimeSlots = CONFIG_BACKUP_COUNT - 1;
  if (datetimeBackups.length > maxDatetimeSlots) {
    // Lexicographic sort = chronological for YYYYMMDD-HHmmss format.
    datetimeBackups.sort();
    const toRemove = datetimeBackups.slice(0, datetimeBackups.length - maxDatetimeSlots);
    for (const old of toRemove) {
      await ioFs.unlink(path.join(dir, old)).catch(() => {
        // best-effort
      });
    }
  }
}

/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: rotate ring -> create new .bak -> harden modes -> prune stale backups.
 */
export async function maintainConfigBackups(
  configPath: string,
  ioFs: BackupMaintenanceFs,
): Promise<void> {
  await rotateConfigBackups(configPath, ioFs);
  await ioFs.copyFile(configPath, `${configPath}.bak`).catch(() => {
    // best-effort
  });
  await hardenBackupPermissions(configPath, ioFs);
  await cleanOrphanBackups(configPath, ioFs);
}
