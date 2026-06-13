// Configures SQLite WAL and related pragmas for local stores.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
export const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS = 30 * 60 * 1000;
const LINUX_NFS_SUPER_MAGIC = 0x6969;
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export type SqliteWalMaintenance = {
  checkpoint: () => boolean;
  close: () => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = {
  autoCheckpointPages?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function findExistingVolumePath(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const stats = fs.statSync(current);
      return stats.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseProcMountInfoEntries(
  contents: string,
): Array<{ mountPoint: string; fsType: string }> {
  const entries: Array<{ mountPoint: string; fsType: string }> = [];
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) {
      continue;
    }
    const fields = line.slice(0, separator).split(" ");
    const suffixFields = line.slice(separator + 3).split(" ");
    const mountPoint = fields[4];
    const fsType = suffixFields[0];
    if (mountPoint && fsType) {
      entries.push({ mountPoint: decodeMountPath(mountPoint), fsType });
    }
  }
  return entries;
}

function parseMountCommandEntries(contents: string): Array<{ mountPoint: string; fsType: string }> {
  const entries: Array<{ mountPoint: string; fsType: string }> = [];
  for (const line of contents.split("\n")) {
    const linuxMatch = /^.* on (.+) type ([^,\s)]+) \(/.exec(line);
    if (linuxMatch) {
      entries.push({ mountPoint: linuxMatch[1], fsType: linuxMatch[2] });
      continue;
    }
    const bsdMatch = /^.* on (.+) \(([^,\s)]+)/.exec(line);
    if (bsdMatch) {
      entries.push({ mountPoint: bsdMatch[1], fsType: bsdMatch[2] });
    }
  }
  return entries;
}

function readMountEntries(): Array<{ mountPoint: string; fsType: string }> {
  try {
    return parseProcMountInfoEntries(fs.readFileSync(PROC_MOUNTINFO_PATH, "utf8"));
  } catch {
    // macOS/BSD expose filesystem type names in `mount` output instead of
    // Linux superblock magic, so keep this fallback for non-Linux NFS mounts.
  }
  try {
    return parseMountCommandEntries(String(childProcess.execFileSync("mount", [])));
  } catch {
    return [];
  }
}

function isPathWithinMount(targetPath: string, mountPoint: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedMountPoint = path.resolve(mountPoint);
  return (
    resolvedTarget === resolvedMountPoint ||
    resolvedMountPoint === path.parse(resolvedMountPoint).root ||
    resolvedTarget.startsWith(`${resolvedMountPoint}${path.sep}`)
  );
}

function isNfsMountType(fsType: string): boolean {
  return fsType.toLowerCase().startsWith("nfs");
}

function isNfsMountEntryPath(targetPath: string): boolean {
  const mountEntry = readMountEntries()
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  return mountEntry ? isNfsMountType(mountEntry.fsType) : false;
}

function isNfsBackedPath(targetPath: string): boolean {
  if (typeof fs.statfsSync !== "function") {
    return isNfsMountEntryPath(targetPath);
  }
  const checkedPath = findExistingVolumePath(targetPath);
  if (!checkedPath) {
    return false;
  }
  try {
    if (fs.statfsSync(checkedPath).type === LINUX_NFS_SUPER_MAGIC) {
      return true;
    }
  } catch {
    return isNfsMountEntryPath(checkedPath);
  }
  return isNfsMountEntryPath(checkedPath);
}

function readJournalModeResult(row: unknown): string | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const value = record.journal_mode ?? Object.values(record)[0];
  return typeof value === "string" ? value.toLowerCase() : null;
}

function requireRollbackJournalMode(db: DatabaseSync, options: SqliteWalMaintenanceOptions): void {
  const row = db.prepare("PRAGMA journal_mode = DELETE;").get();
  const journalMode = readJournalModeResult(row);
  if (journalMode !== "delete") {
    const label = options.databaseLabel ?? "sqlite database";
    const location = options.databasePath ? ` at ${options.databasePath}` : "";
    const actual = journalMode ?? "unknown";
    throw new Error(
      `${label}${location} is on an NFS-backed volume but SQLite kept journal_mode=${actual}; refusing to continue with WAL on NFS.`,
    );
  }
}

/** Configure WAL pragmas and return a handle for checkpoint/close maintenance. */
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  options: SqliteWalMaintenanceOptions = {},
): SqliteWalMaintenance {
  const autoCheckpointPages = normalizeNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  if (options.databasePath && isNfsBackedPath(options.databasePath)) {
    requireRollbackJournalMode(db, options);
    return {
      checkpoint: () => true,
      close: () => true,
    };
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);

  const checkpoint = (): boolean => {
    try {
      db.exec(`PRAGMA wal_checkpoint(${checkpointMode});`);
      return true;
    } catch (error) {
      options.onCheckpointError?.(error);
      return false;
    }
  };

  let timer: IntervalHandle | null = null;
  if (timerIntervalMs > 0) {
    timer = setInterval(checkpoint, timerIntervalMs) as IntervalHandle;
    timer.unref?.();
  }

  return {
    checkpoint,
    close: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return checkpoint();
    },
  };
}
