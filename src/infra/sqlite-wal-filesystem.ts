// Filesystem policy for SQLite creation and journaling.
import fs from "node:fs";
import path from "node:path";
import { probeTreeClone } from "@openclaw/fs-safe/copy";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import type { Result } from "@openclaw/normalization-core/result";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errno.js";

const ROLLBACK_FILESYSTEM_MAGIC = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x01021997, // 9p (V9FS)
]);
const LINUX_BTRFS_SUPER_MAGIC = 0x9123683e;
const PROC_MOUNTINFO_PATH = "/proc/self/mountinfo";
// Filesystem classification runs during database open, so never let the fallback probe stall it.
const MOUNT_COMMAND_TIMEOUT_MS = 1_000;
const NETWORK_FILESYSTEM_TYPES = new Set(["cifs", "smbfs", "smb2", "smb3"]);
// Cross-VM filesystems (virtiofs, 9p) cannot provide the shared-memory
// coherence SQLite WAL requires; fall back to rollback journaling.
const CROSS_VM_FILESYSTEM_TYPES = new Set(["virtiofs", "fuse.virtiofs", "9p", "9p2000.l"]);

const log = createSubsystemLogger("infra/sqlite-wal");
let warnedNoCow = false;

type SqliteFilesystemJournalPolicy = "rollback" | "unsupported" | "wal";
type MountEntry = { mountPoint: string; fsType: string; source?: string };

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
    return hasErrnoCode(error, "ETIMEDOUT")
      ? { ok: false, error: "timeout" }
      : { ok: true, value: [] };
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
  if (
    normalized.startsWith("nfs") ||
    NETWORK_FILESYSTEM_TYPES.has(normalized) ||
    CROSS_VM_FILESYSTEM_TYPES.has(normalized) ||
    normalized.startsWith("9p")
  ) {
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

function findMountEntry(targetPath: string, mountEntries: MountEntry[]): MountEntry | undefined {
  return mountEntries
    .filter((entry) => isPathWithinMount(targetPath, entry.mountPoint))
    .toSorted((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
}

function resolveMountEntryJournalPolicy(
  targetPath: string,
  mountEntries: MountEntry[],
): SqliteFilesystemJournalPolicy {
  const mountEntry = findMountEntry(targetPath, mountEntries);
  return mountEntry ? resolveMountTypeJournalPolicy(mountEntry) : "wal";
}

/** Classify the physical store location, including a not-yet-created database. */
export function isSqlitePathOnBtrfs(targetPath: string): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const checkedPaths = findExistingVolumePaths(targetPath);
  if (!checkedPaths) {
    return false;
  }
  try {
    return fs.statfsSync(checkedPaths.canonicalPath).type === LINUX_BTRFS_SUPER_MAGIC;
  } catch {
    const mounts = readMountEntries();
    return (
      mounts.ok &&
      findMountEntry(checkedPaths.canonicalPath, mounts.value)?.fsType.toLowerCase() === "btrfs"
    );
  }
}

/** Doctor requires failure to abort publication; never apply attributes to data files. */
export function setSqliteDirectoryNoCow(directory: string): void {
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`SQLite NOCOW target is not a directory: ${directory}`);
  }
  const result = process
    .getBuiltinModule("node:child_process")
    .spawnSync("chattr", ["+C", directory], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: MOUNT_COMMAND_TIMEOUT_MS,
      maxBuffer: 4096,
    });
  if (result.error || result.status !== 0) {
    throw (
      result.error ??
      new Error(`chattr +C failed: ${result.stderr.trim() || result.signal || result.status}`)
    );
  }
}

/** Called after directory permissions are established, before SQLite creates any files. */
export function prepareSqliteDatabaseDirectory(databasePath: string): void {
  if (process.platform !== "linux" || fs.existsSync(databasePath)) {
    return;
  }
  try {
    if (isSqlitePathOnBtrfs(databasePath)) {
      setSqliteDirectoryNoCow(path.dirname(databasePath));
    }
  } catch (error) {
    if (!warnedNoCow) {
      warnedNoCow = true;
      log.warn("Could not enable SQLite directory NOCOW; continuing with filesystem defaults", {
        databasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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

export function resolvePathJournalPolicy(targetPath: string): SqliteFilesystemJournalPolicy {
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
    if (ROLLBACK_FILESYSTEM_MAGIC.has(fs.statfsSync(checkedPaths.canonicalPath).type)) {
      return "rollback";
    }
  } catch {
    // Missing native metadata falls through to the same mount policy lookup.
  }
  return combineMountEntryJournalPolicies(mountLookupPaths);
}
