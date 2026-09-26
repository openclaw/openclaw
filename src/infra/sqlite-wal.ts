// Configures SQLite WAL and related pragmas for local stores.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { probeTreeClone } from "@openclaw/fs-safe/copy";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeSqliteNonNegativeInteger,
  runWithSqliteBusyTimeout,
} from "./sqlite-busy-timeout.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-coordinator.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import {
  createSqliteWalCheckpoint,
  type SqliteWalCheckpointMode,
  type SqliteWalCheckpointOptions,
  type SqliteWalHealth,
} from "./sqlite-wal-checkpoint.js";
import {
  reclaimSqliteWalFreePages,
  type SqliteWalReclamationOptions,
  type SqliteWalReclamationResult,
} from "./sqlite-wal-reclamation.js";
import {
  detectSqliteWalSplitBrain,
  terminateForSqliteWalSplitBrain,
  type SqliteWalSplitBrainEvent,
} from "./sqlite-wal-split-brain.js";
import {
  cancelSqliteWalWriteAdmission,
  createSqliteWalMaintenanceScheduler,
} from "./sqlite-wal-write-admission.js";

export type { SqliteWalHealth } from "./sqlite-wal-checkpoint.js";
export type { SqliteWalReclamationResult } from "./sqlite-wal-reclamation.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
const DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
// SQLite applies this ceiling when a fully checkpointed WAL resets on the next
// commit. Keep it well above the usual ~4 MiB autocheckpoint window so only
// pathological high-water marks pay the truncation cost.
const DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const LINUX_NFS_SUPER_MAGIC = 0x6969;
const LINUX_SMB_SUPER_MAGIC = 0x517b;
const LINUX_CIFS_SUPER_MAGIC = 0xff534d42;
const LINUX_SMB2_SUPER_MAGIC = 0xfe534d42;
const LINUX_V9FS_SUPER_MAGIC = 0x01021997; // Linux 9p (V9FS)
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";
// Filesystem classification runs during database open, so never let the fallback probe stall it.
const MOUNT_COMMAND_TIMEOUT_MS = 1_000;
const NETWORK_FILESYSTEM_TYPES = new Set(["cifs", "smbfs", "smb2", "smb3"]);
// Cross-VM filesystems (virtiofs, 9p) cannot provide the shared-memory
// coherence SQLite WAL requires; fall back to rollback journaling.
const CROSS_VM_FILESYSTEM_TYPES = new Set(["virtiofs", "fuse.virtiofs", "9p", "9p2000.l"]);
const JOURNAL_MODE_RETRY_INTERVAL_MS = 10;
const JOURNAL_MODE_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

const log = createSubsystemLogger("infra/sqlite-wal");

// Gateway bootstrap loads the database owner before admitting turns. Long-lived
// maintenance timers must not retain the context of a turn that opens a database.
export const runInSqliteMaintenanceContext = AsyncLocalStorage.snapshot();

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteFilesystemJournalPolicy = "rollback" | "unsupported" | "wal";
type MountEntry = { mountPoint: string; fsType: string; source?: string };

export type SqliteWalMaintenance = {
  /** Last maintenance observation; reading it never checkpoints or probes storage. */
  readonly health?: SqliteWalHealth;
  checkpoint: () => boolean;
  reclaimFreePages: (options?: SqliteWalReclamationOptions) => SqliteWalReclamationResult;
  /** Inspect this retained WAL connection, independently of checkpoint completion elsewhere. */
  inspectIdle?: () => "healthy" | "retire";
  close: (options?: { checkpointMode?: SqliteWalCheckpointMode }) => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = SqliteWalCheckpointOptions & {
  autoCheckpointPages?: number;
  busyTimeoutMs?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  /** Owner-held synchronous exclusion around maintenance writes, including periodic vacuum. */
  runMaintenance?: (operation: () => boolean) => boolean;
};

export type SqliteConnectionPragmaOptions = SqliteWalMaintenanceOptions & {
  foreignKeys?: boolean;
  synchronous?: "NORMAL";
};

function configureSqliteBusyTimeout(db: DatabaseSync, busyTimeoutMs: number): number {
  const normalizedTimeoutMs = normalizeSqliteNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
  db.exec(`PRAGMA busy_timeout = ${normalizedTimeoutMs};`);
  return normalizedTimeoutMs;
}

/** Restrict inspection connections without changing journal or persistence policy. */
export function configureSqliteReadOnlyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
}

// auto_vacuum only takes effect when set before the first page is written.
// Existing databases require an offline VACUUM owned by doctor/maintenance.
function enableIncrementalAutoVacuumForFreshDatabase(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA page_count").get() as { page_count?: unknown } | undefined;
  if (row?.page_count === 0) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  }
}

/**
 * Configure lock retry before inspecting or mutating a fresh database header.
 * Concurrent first opens can otherwise fail before schema transactions begin.
 */
export function configureSqlitePreSchemaPragmas(
  db: DatabaseSync,
  options: Pick<SqliteConnectionPragmaOptions, "busyTimeoutMs"> = {},
): void {
  if (options.busyTimeoutMs !== undefined) {
    configureSqliteBusyTimeout(db, options.busyTimeoutMs);
  }
  enableIncrementalAutoVacuumForFreshDatabase(db);
}

function findExistingVolumePaths(
  targetPath: string,
): { canonicalPath: string; originalPath: string } | null {
  let current = path.resolve(targetPath);
  while (true) {
    let stats: ReturnType<typeof fs.statSync>;
    try {
      stats = fs.statSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
      continue;
    }
    const existingPath = fs.realpathSync(current);
    return {
      canonicalPath: stats.isDirectory() ? existingPath : path.dirname(existingPath),
      originalPath: stats.isDirectory() ? current : path.dirname(current),
    };
  }
}

function parseProcMountInfoEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
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
      entries.push({
        mountPoint: decodeMountInfoPath(mountPoint),
        fsType,
        ...(suffixFields[1] ? { source: decodeMountInfoPath(suffixFields[1]) } : {}),
      });
    }
  }
  return entries;
}

function parseMountCommandEntries(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    const match =
      /^(.+) on (.+) type ([^,\s)]+) \(/.exec(line) ?? /^(.+) on (.+) \(([^,\s)]+)/.exec(line);
    if (match) {
      const [, source, mountPoint, fsType] = match;
      if (source && mountPoint && fsType) {
        entries.push({ source, mountPoint, fsType });
      }
    }
  }
  return entries;
}

function isMountCommandTimeout(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT"
  );
}

function readMountEntries(): Result<MountEntry[], "timeout"> {
  try {
    return {
      ok: true,
      value: parseProcMountInfoEntries(fs.readFileSync(PROC_MOUNTINFO_PATH, "utf8")),
    };
  } catch {
    // macOS/BSD expose filesystem type names in `mount` output instead of
    // Linux superblock magic, so keep this fallback for named filesystem types.
  }
  try {
    return {
      ok: true,
      value: parseMountCommandEntries(
        String(
          process.getBuiltinModule("node:child_process").execFileSync("mount", [], {
            killSignal: "SIGKILL",
            timeout: MOUNT_COMMAND_TIMEOUT_MS,
          }),
        ),
      ),
    };
  } catch (error) {
    return isMountCommandTimeout(error) ? { ok: false, error: "timeout" } : { ok: true, value: [] };
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

function isSshfsMountSource(source: string | undefined): boolean {
  if (!source) {
    return false;
  }
  const normalized = source.toLowerCase();
  return (
    normalized === "sshfs" ||
    normalized.startsWith("sshfs#") ||
    normalized.startsWith("sshfs@") ||
    /^(?:[^/\s:]+@)?[^/\s:]+:.*/u.test(source)
  );
}

function resolveMountTypeJournalPolicy(entry: MountEntry): SqliteFilesystemJournalPolicy {
  const normalized = entry.fsType.toLowerCase();
  if (normalized.startsWith("nfs") || NETWORK_FILESYSTEM_TYPES.has(normalized)) {
    return "rollback";
  }
  if (CROSS_VM_FILESYSTEM_TYPES.has(normalized) || normalized.startsWith("9p")) {
    return "rollback";
  }
  if (normalized === "fuse.sshfs") {
    return "unsupported";
  }
  if ((normalized === "macfuse" || normalized === "osxfuse") && isSshfsMountSource(entry.source)) {
    return "unsupported";
  }
  return "wal";
}

function resolveMountEntryJournalPolicy(
  targetPath: string,
  mountEntries: MountEntry[],
): SqliteFilesystemJournalPolicy {
  const mountEntry = mountEntries
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  return mountEntry ? resolveMountTypeJournalPolicy(mountEntry) : "wal";
}

function combineMountEntryJournalPolicies(
  targetPaths: readonly [string, string],
): SqliteFilesystemJournalPolicy {
  const mountResult = readMountEntries();
  if (!mountResult.ok) {
    const [originalPath, canonicalPath] = targetPaths;
    if (process.platform === "darwin" && originalPath === canonicalPath) {
      try {
        // This read-only probe identifies APFS by its native name, not a numeric type.
        // Aliased paths still require mount metadata for both original and real locations.
        if (probeTreeClone(canonicalPath) === "apfs") {
          return "wal";
        }
      } catch {
        // Failed native inspection cannot override the unknown-filesystem policy.
      }
    }
    return "rollback";
  }
  const policies = new Set(
    targetPaths.map((targetPath) => resolveMountEntryJournalPolicy(targetPath, mountResult.value)),
  );
  if (policies.has("unsupported")) {
    return "unsupported";
  }
  return policies.has("rollback") ? "rollback" : "wal";
}

function isWindowsUncPath(targetPath: string): boolean {
  return (
    /^\\\\\?\\UNC\\[^\\]+\\[^\\]+/i.test(targetPath) ||
    /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(targetPath)
  );
}

function isWindowsDrivePath(targetPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\\?\\[A-Za-z]:[\\/]/i.test(targetPath);
}

function resolvePathJournalPolicy(targetPath: string): SqliteFilesystemJournalPolicy {
  if (process.platform === "win32") {
    const normalizedTargetPath = path.win32.normalize(targetPath);
    if (isWindowsUncPath(normalizedTargetPath)) {
      return "rollback";
    }
    if (isWindowsDrivePath(normalizedTargetPath)) {
      try {
        return isWindowsUncPath(path.win32.normalize(fs.realpathSync.native(targetPath)))
          ? "rollback"
          : "wal";
      } catch {
        // Windows can deny SMB path normalization when parent components are
        // unreadable. Treat an unclassifiable opened database as network-backed.
        return "rollback";
      }
    }
  }
  const checkedPaths = findExistingVolumePaths(targetPath);
  if (!checkedPaths) {
    return "wal";
  }
  const mountLookupPaths = [checkedPaths.originalPath, checkedPaths.canonicalPath] as const;
  if (typeof fs.statfsSync !== "function") {
    return combineMountEntryJournalPolicies(mountLookupPaths);
  }
  try {
    const filesystemType = fs.statfsSync(checkedPaths.canonicalPath).type;
    if (
      filesystemType === LINUX_NFS_SUPER_MAGIC ||
      filesystemType === LINUX_SMB_SUPER_MAGIC ||
      filesystemType === LINUX_CIFS_SUPER_MAGIC ||
      filesystemType === LINUX_SMB2_SUPER_MAGIC ||
      filesystemType === LINUX_V9FS_SUPER_MAGIC
    ) {
      return "rollback";
    }
  } catch {
    return combineMountEntryJournalPolicies(mountLookupPaths);
  }
  return combineMountEntryJournalPolicies(mountLookupPaths);
}

function readJournalModeResult(row: unknown): string | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const record = row as Record<string, unknown>;
  const value = record.journal_mode ?? Object.values(record)[0];
  return typeof value === "string" ? value.toLowerCase() : null;
}

function hasInMemoryMainDatabase(db: DatabaseSync): boolean {
  const rows = db.prepare("PRAGMA database_list;").all() as Array<{
    file?: unknown;
    name?: unknown;
  }>;
  const main = rows.find((row) => row.name === "main");
  return main?.file === "";
}

function requireRollbackJournalMode(db: DatabaseSync, options: SqliteWalMaintenanceOptions): void {
  const row = db.prepare("PRAGMA journal_mode = DELETE;").get();
  const journalMode = readJournalModeResult(row);
  if (journalMode !== "delete") {
    const label = options.databaseLabel ?? "sqlite database";
    const location = options.databasePath ? ` at ${options.databasePath}` : "";
    const actual = journalMode ?? "unknown";
    throw new Error(
      `${label}${location} is on a network-backed volume but SQLite kept journal_mode=${actual}; refusing to continue with WAL on network storage.`,
    );
  }
}

function enableWalJournalMode(
  db: DatabaseSync,
  retryTimeoutMs: number,
  options: SqliteWalMaintenanceOptions,
): boolean {
  const deadline = performance.now() + retryTimeoutMs;
  let restoreBusyTimeout = false;
  try {
    while (true) {
      try {
        db.exec("PRAGMA journal_mode = WAL;");
        const journalMode = readJournalModeResult(db.prepare("PRAGMA journal_mode;").get());
        if (journalMode === "wal") {
          return true;
        }
        // SQLite's in-memory databases cannot use WAL and correctly retain
        // journal_mode=memory. They have no sidecars or checkpoint work.
        if (journalMode === "memory" && hasInMemoryMainDatabase(db)) {
          return false;
        }
        const label = options.databaseLabel ?? "sqlite database";
        const location = options.databasePath ? ` at ${options.databasePath}` : "";
        throw new Error(
          `${label}${location} could not enable WAL; SQLite kept journal_mode=${journalMode ?? "unknown"}.`,
        );
      } catch (error) {
        const remainingMs = Math.max(0, deadline - performance.now());
        if (!isSqliteLockError(error) || remainingMs <= 0) {
          throw error;
        }
        if (!restoreBusyTimeout) {
          // A busy handler can be bypassed to avoid deadlock. Disable it after
          // the first BUSY so explicit retries cannot overrun this deadline.
          configureSqliteBusyTimeout(db, 0);
          restoreBusyTimeout = true;
        }
        Atomics.wait(
          JOURNAL_MODE_RETRY_SLEEP,
          0,
          0,
          Math.min(JOURNAL_MODE_RETRY_INTERVAL_MS, remainingMs),
        );
      }
    }
  } finally {
    if (restoreBusyTimeout) {
      configureSqliteBusyTimeout(db, retryTimeoutMs);
    }
  }
}

function enableMacosCheckpointFullfsync(db: DatabaseSync): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    db.exec("PRAGMA checkpoint_fullfsync = 1;");
  } catch {
    // Older SQLite builds may ignore or reject platform-specific pragmas. WAL
    // setup should still proceed because this is a durability upgrade, not a
    // prerequisite for opening the store.
  }
}

function refuseUnsupportedFilesystem(options: SqliteWalMaintenanceOptions): never {
  const label = options.databaseLabel ?? "sqlite database";
  const location = options.databasePath ? ` at ${options.databasePath}` : "";
  throw new Error(
    `${label}${location} is on SSHFS, which cannot safely coordinate SQLite writes across mounts; refusing to open the database.`,
  );
}

/** Configure safe journaling pragmas and return a handle for checkpoint/close maintenance. */
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  options: SqliteWalMaintenanceOptions = {},
): SqliteWalMaintenance {
  const busyTimeoutMs =
    options.busyTimeoutMs === undefined ? 0 : configureSqliteBusyTimeout(db, options.busyTimeoutMs);
  const autoCheckpointPages = normalizeSqliteNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeSqliteNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  const periodicCheckpointMode = options.checkpointMode ?? "PASSIVE";
  const journalPolicy = options.databasePath
    ? resolvePathJournalPolicy(options.databasePath)
    : "wal";
  if (journalPolicy === "unsupported") {
    refuseUnsupportedFilesystem(options);
  }
  if (journalPolicy === "rollback") {
    requireRollbackJournalMode(db, options);
  }
  if (journalPolicy === "rollback" || !enableWalJournalMode(db, busyTimeoutMs, options)) {
    return {
      checkpoint: () => true,
      reclaimFreePages: (reclaimOptions = {}) =>
        reclaimSqliteWalFreePages(db, () => true, reclaimOptions),
      close: () => true,
    };
  }
  enableMacosCheckpointFullfsync(db);
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);
  db.exec(`PRAGMA journal_size_limit = ${DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES};`);
  const tripwireDatabasePath =
    process.platform === "linux" && options.databasePath && fs.existsSync(options.databasePath)
      ? fs.realpathSync.native(options.databasePath)
      : undefined;
  let invalidated = false;
  let splitBrainDetectionEnabled = Boolean(tripwireDatabasePath);
  let splitBrainDetectionWarningLogged = false;
  const checkpointOwner = createSqliteWalCheckpoint(
    db,
    options,
    DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES,
  );
  const runCheckpoint = checkpointOwner.checkpoint;

  const runMaintenance = (operation: () => boolean): boolean => {
    if (invalidated) {
      return false;
    }
    try {
      return options.runMaintenance ? options.runMaintenance(operation) : operation();
    } catch (error) {
      checkpointOwner.recordError(error);
      return false;
    }
  };
  const checkpoint = (): boolean => runMaintenance(() => runCheckpoint(checkpointMode));
  const reclaimFreePages = (
    reclaimOptions: SqliteWalReclamationOptions = {},
  ): SqliteWalReclamationResult => {
    let result: SqliteWalReclamationResult | undefined;
    let failure: { error: unknown } | undefined;
    runMaintenance(() => {
      try {
        result = reclaimSqliteWalFreePages(db, runCheckpoint, reclaimOptions);
        return result.checkpointCompleted;
      } catch (error) {
        failure = { error };
        throw error;
      }
    });
    if (failure) {
      throw failure.error;
    }
    if (!result) {
      throw new Error("SQLite page reclamation owner is unavailable");
    }
    return { ...result, checkpoint: checkpointOwner.snapshot };
  };

  let timer: IntervalHandle | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const maintain = createSqliteWalMaintenanceScheduler(
    db,
    (maxPages) => {
      // Admission may outlive this timer or its exact native connection.
      if (!timer || invalidated) {
        return 0;
      }
      let reclaimedPages = 0;
      runMaintenance(() => {
        const reclaimed = reclaimSqliteWalFreePages(db, runCheckpoint, {
          checkpointMode: periodicCheckpointMode,
          maxPages,
        });
        const checkpointed = reclaimed.checkpointCompleted;
        if (
          checkpointed &&
          reclaimed.freePagesBefore !== null &&
          reclaimed.remainingFreePages !== null
        ) {
          reclaimedPages = Math.min(
            reclaimed.vacuumPagesRequested,
            reclaimed.freePagesBefore - reclaimed.remainingFreePages,
          );
        }
        if (
          checkpointed &&
          periodicCheckpointMode === "PASSIVE" &&
          (checkpointOwner.health?.walBytes ?? 0) > DEFAULT_SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES
        ) {
          // A completed PASSIVE checkpoint need not recycle its high-water file
          // until another commit. Try once without waiting for readers or writers.
          runWithSqliteBusyTimeout(db, 0, () => runCheckpoint("TRUNCATE"));
        }
        return checkpointed;
      });
      return reclaimedPages;
    },
    (error) => checkpointOwner.recordError(error),
    512,
  );
  const maintainPeriodically = (retry = true) => {
    void maintain().then(() => {
      if (retry && timer && !invalidated && checkpointOwner.health?.blockingOwner && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          maintainPeriodically(false);
        }, 1_000);
        retryTimer.unref();
      }
    });
  };
  if (timerIntervalMs > 0) {
    timer = runInSqliteMaintenanceContext(
      () =>
        setInterval(() => {
          if (!timer || invalidated) {
            return;
          }
          if (tripwireDatabasePath && splitBrainDetectionEnabled) {
            let splitBrain: SqliteWalSplitBrainEvent | undefined;
            try {
              splitBrain = detectSqliteWalSplitBrain(tripwireDatabasePath);
            } catch (error) {
              splitBrainDetectionEnabled = false;
              if (!splitBrainDetectionWarningLogged) {
                splitBrainDetectionWarningLogged = true;
                log.warn("SQLite WAL split-brain detection disabled", {
                  databaseLabel: options.databaseLabel,
                  databasePath: tripwireDatabasePath,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            if (splitBrain) {
              invalidated = true;
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
              terminateForSqliteWalSplitBrain(splitBrain, options.databaseLabel);
            }
          }
          maintainPeriodically();
        }, timerIntervalMs) as IntervalHandle,
    );
    timer.unref?.();
  }

  return {
    get health() {
      return checkpointOwner.health;
    },
    checkpoint,
    reclaimFreePages,
    inspectIdle: () => (runMaintenance(checkpointOwner.inspectIdle) ? "healthy" : "retire"),
    close: (closeOptions) => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      clearInterval(timer ?? undefined);
      timer = null;
      cancelSqliteWalWriteAdmission(db);
      if (invalidated) {
        return false;
      }
      // Cache eviction passes PASSIVE: a TRUNCATE close-checkpoint waits on
      // readers and has starved the event loop for seconds under fleet churn.
      // Orderly dispose/delete keeps TRUNCATE so sidecars are flushed for unlink.
      return runMaintenance(() => runCheckpoint(closeOptions?.checkpointMode ?? checkpointMode));
    },
  };
}

type SqliteExitRegistration = { close: () => void; fired: boolean };
type SqliteExitGroup = {
  pending: Set<SqliteExitRegistration>;
  dispatch: () => void;
};
let lastSqliteExitGroup: SqliteExitGroup | undefined;

function detachEmptySqliteExitGroup(group: SqliteExitGroup): void {
  if (group.pending.size > 0) {
    return;
  }
  if (lastSqliteExitGroup === group) {
    lastSqliteExitGroup = undefined;
  }
  process.removeListener("exit", group.dispatch);
}

/**
 * Register a best-effort exit-time close for a SQLite handle cache. Returns an
 * unregister callback the cache's orderly close path must invoke, so tests and
 * runtime shutdowns do not accumulate listeners on shared worker processes.
 */
export function registerSqliteCacheExitClose(closeAll: () => void): () => void {
  const registration = { close: closeAll, fired: false };
  let group = lastSqliteExitGroup;
  // Preserve intervening owners, such as capture finalization before database close.
  if (!group || process.listeners("exit").at(-1) !== group.dispatch) {
    const pending = new Set([registration]);
    const created: SqliteExitGroup = {
      pending,
      dispatch: () => {
        // Snapshot this batch before callbacks; disposal cannot skip an admitted close.
        const snapshot = [...pending];
        for (const entry of snapshot) {
          if (entry.fired) {
            continue;
          }
          entry.fired = true;
          pending.delete(entry);
          detachEmptySqliteExitGroup(created);
          try {
            entry.close();
          } catch {
            // Exit-time close is best-effort; unclean exits rely on WAL recovery.
          }
        }
      },
    };
    // Keep the dispatcher until the last callback starts, including nested emissions.
    process.on("exit", created.dispatch);
    lastSqliteExitGroup = group = created;
  } else {
    group.pending.add(registration);
  }
  const owner = group;
  return () => {
    owner.pending.delete(registration);
    detachEmptySqliteExitGroup(owner);
  };
}

/** Configure per-connection SQLite pragmas in the safe lock-retry/WAL order. */
export function configureSqliteConnectionPragmas(
  db: DatabaseSync,
  options: SqliteConnectionPragmaOptions = {},
): SqliteWalMaintenance {
  const { foreignKeys, synchronous, ...walOptions } = options;
  const maintenance = configureSqliteWalMaintenance(db, walOptions);
  try {
    if (synchronous) {
      db.exec(`PRAGMA synchronous = ${synchronous};`);
    }
    if (foreignKeys) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    return maintenance;
  } catch (error) {
    // The caller cannot dispose maintenance until this function returns it.
    try {
      maintenance.close();
    } catch (closeError) {
      throw createSqliteLifecycleAggregateError(
        [error, closeError],
        "SQLite connection pragma configuration and WAL maintenance cleanup both failed.",
        error,
      );
    }
    throw error;
  }
}
