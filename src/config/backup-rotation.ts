import path from "node:path";

export const CONFIG_BACKUP_COUNT = 5;

/** Matches datetime suffixes: YYYYMMDD-HHmmss with optional -N collision suffix */
const DATETIME_SUFFIX_RE = /^\d{8}-\d{6}(-\d+)?$/;

/** Matches legacy numeric suffixes from the old ring rotation (single digit 0-9). */
const LEGACY_SUFFIX_RE = /^\d$/;

/** Parse a datetime suffix into [base, collisionIndex] for numeric sorting. */
function parseDatetimeSuffix(suffix: string): [string, number] {
  const dashIdx = suffix.indexOf("-", 15); // skip past YYYYMMDD-HHmmss (15 chars)
  if (dashIdx === -1) {
    return [suffix, 0];
  }
  return [suffix.slice(0, dashIdx), Number(suffix.slice(dashIdx + 1))];
}

export interface BackupRotationFs {
  unlink: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ isFile(): boolean }>;
}

export interface BackupMaintenanceFs extends BackupRotationFs {
  copyFile: (from: string, to: string) => Promise<void>;
}

/**
 * Generate a UTC datetime suffix in YYYYMMDD-HHmmss format.
 * Exported for testing; override via the `now` parameter.
 */
export function formatBackupTimestamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const mi = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Create a new timestamped backup of the current `.bak` file.
 * If a backup with the same timestamp already exists, appends a numeric
 * collision suffix (e.g. `-2`, `-3`).
 */
export async function rotateConfigBackups(
  configPath: string,
  ioFs: BackupRotationFs,
  now?: Date,
): Promise<void> {
  const backupBase = `${configPath}.bak`;
  const timestamp = formatBackupTimestamp(now);
  let target = `${backupBase}.${timestamp}`;

  // Handle sub-second collision: if file exists, append -N.
  // Always start at collision 1 so that an unsuffixed (index 0) base name is never
  // recreated after pruning — prevents the prune-recreate cycle described in #39923.
  if (ioFs.stat) {
    try {
      await ioFs.stat(target);
      // Unsuffixed target exists; switch to collision numbering
      let collision = 1;
      target = `${backupBase}.${timestamp}-${collision}`;
      while (collision <= 99) {
        try {
          await ioFs.stat(target);
          collision++;
          target = `${backupBase}.${timestamp}-${collision}`;
        } catch {
          break;
        }
      }
    } catch {
      // File does not exist — safe to use unsuffixed
    }
  }

  await ioFs.rename(backupBase, target).catch(() => {
    // best-effort: .bak may not exist on first run
  });
}

/**
 * Harden file permissions on all `.bak*` files in the config directory.
 * Scans the directory for files matching the backup pattern instead of
 * iterating over a fixed numbered range.
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
  const bakName = `${base}.bak`;

  // Harden the primary .bak
  await ioFs.chmod(path.join(dir, bakName), 0o600).catch(() => {
    // best-effort
  });

  // Harden all .bak.* files found in the directory
  if (ioFs.readdir) {
    const bakDotPrefix = `${bakName}.`;
    let entries: string[];
    try {
      entries = await ioFs.readdir(dir);
    } catch {
      return; // best-effort
    }
    for (const entry of entries) {
      if (entry.startsWith(bakDotPrefix)) {
        await ioFs.chmod(path.join(dir, entry), 0o600).catch(() => {
          // best-effort
        });
      }
    }
  }
}

/**
 * Collect all `.bak.*` suffixes from the config directory, categorized as
 * datetime, legacy numeric, or orphan.
 */
function categorizeBackupSuffixes(
  entries: string[],
  bakPrefix: string,
): { datetime: string[]; legacy: string[]; orphan: string[] } {
  const datetime: string[] = [];
  const legacy: string[] = [];
  const orphan: string[] = [];

  for (const entry of entries) {
    if (!entry.startsWith(bakPrefix)) {
      continue;
    }
    const suffix = entry.slice(bakPrefix.length);
    if (DATETIME_SUFFIX_RE.test(suffix)) {
      datetime.push(suffix);
    } else if (LEGACY_SUFFIX_RE.test(suffix)) {
      legacy.push(suffix);
    } else {
      orphan.push(suffix);
    }
  }

  return { datetime, legacy, orphan };
}

/**
 * Remove backup files that exceed the keep-N limit, and delete orphans.
 *
 * Datetime-suffixed and legacy numeric backups both count toward the
 * CONFIG_BACKUP_COUNT limit. Datetime backups are sorted by parsed
 * timestamp and collision index. Legacy numeric files (single-digit ring
 * indices) are preserved during migration but count toward the limit.
 * Non-matching suffixes (orphans) are always removed.
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

  const { datetime, legacy, orphan } = categorizeBackupSuffixes(entries, bakPrefix);

  // Delete all orphan files (non-datetime, non-legacy)
  for (const suffix of orphan) {
    await ioFs.unlink(path.join(dir, `${bakPrefix}${suffix}`)).catch(() => {
      // best-effort
    });
  }

  // The primary .bak counts as 1 slot, so we keep at most (N - 1) suffixed backups.
  const maxSuffixed = CONFIG_BACKUP_COUNT - 1;

  // Sort datetime descending (most recent first) by parsed base + collision index.
  // Pure lexicographic sort is incorrect once collision suffixes exist
  // (e.g. "-10" sorts before "-5" lexicographically).
  datetime.sort((a, b) => {
    const [aBase, aIdx] = parseDatetimeSuffix(a);
    const [bBase, bIdx] = parseDatetimeSuffix(b);
    if (aBase !== bBase) {
      return aBase > bBase ? -1 : 1;
    }
    // Higher collision index = more recent write within the same second
    return bIdx - aIdx;
  });

  // Sort legacy ascending by numeric value so smallest indices are "most recent"
  legacy.sort((a, b) => Number(a) - Number(b));

  // Merge: datetime first (most recent), then legacy
  const allValid = [...datetime, ...legacy];

  // Keep the first maxSuffixed, delete the rest
  const toDelete = allValid.slice(maxSuffixed);
  for (const suffix of toDelete) {
    await ioFs.unlink(path.join(dir, `${bakPrefix}${suffix}`)).catch(() => {
      // best-effort
    });
  }
}

/**
 * Run the full backup maintenance cycle around config writes.
 * Order matters: rotate (rename .bak to .bak.<timestamp>) -> create new .bak
 * -> harden modes -> prune excess and orphan .bak.* files.
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
