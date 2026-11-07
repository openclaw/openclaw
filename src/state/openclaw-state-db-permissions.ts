import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { hasErrnoCode } from "../infra/errno.js";
import { applyPrivateModeSync, applyPrivateModeToFdSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const OPENCLAW_STATE_DIR_MODE = 0o700;
const OPENCLAW_STATE_FILE_MODE = 0o600;

const stateDbLog = createSubsystemLogger("state/db");

/** Targets already warned about, so chmod-less filesystems warn once per path. */
const chmodWarnedTargets = createDedupeCache({
  ttlMs: 0,
  maxSize: 4096,
});

// Permission hardening is best-effort only on filesystems that cannot apply
// it: the database stays usable without the chmod, and crashing at open would
// take the gateway down on Azure Files/NFS/Docker volumes (#91919). Unexpected
// chmod failures on owned paths still throw so credentials-adjacent hardening stays loud.
function bestEffortChmodSync(target: string, mode: number): void {
  let result: ReturnType<typeof applyPrivateModeSync>;
  try {
    result = applyPrivateModeSync(target, mode);
  } catch (error) {
    if (
      !hasErrnoCode(error, "EPERM") ||
      !process.getuid ||
      statSync(target).uid === process.getuid()
    ) {
      throw error;
    }
    // Group/ACL-writable shared volumes need not grant permission to chmod their owner's files.
    // The actual database open/write still decides whether this process can use the store.
    result = { applied: false, error };
  }
  if (result.applied || chmodWarnedTargets.check(target)) {
    return;
  }
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

/** Private stores this installation owns beside its shared state database. */
const PRIVATE_STATE_STORES = Object.freeze([
  // Keep in step with resolveClientCredentialStorePath and
  // resolveDaemonRuntimePinStorePath; openclaw-state-db-permissions.test.ts asserts it.
  ["client", "credentials.sqlite"],
  ["control", "services.sqlite"],
] as const);

/** Mirrors resolveUpdateCaptureRoot, which is a hard sibling of the state directory. */
const UPDATE_CAPTURE_ROOT_SUFFIX = ".update-captures";

// Restoration binds every mutation to an open descriptor. Pathname chmod
// re-resolves each component, so an alias introduced above or at the target
// after admission would receive the change instead of the verified object
// (clawsweeper review of #194307).
function bestEffortFchmodSync(fd: number, target: string, mode: number): void {
  let result: ReturnType<typeof applyPrivateModeToFdSync>;
  try {
    result = applyPrivateModeToFdSync(fd, target, mode);
  } catch (error) {
    if (
      !hasErrnoCode(error, "EPERM") ||
      !process.getuid ||
      fstatSync(fd).uid === process.getuid()
    ) {
      throw error;
    }
    // Group/ACL-writable shared volumes need not grant permission to chmod their owner's files.
    // The actual database open/write still decides whether this process can use the store.
    result = { applied: false, error };
  }
  if (result.applied || chmodWarnedTargets.check(target)) {
    return;
  }
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

/** Opens an enumerated store path, refusing a symlink standing in for it. */
function openStorePathSync(target: string, directory: boolean): number | undefined {
  const flags =
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (directory ? fsConstants.O_DIRECTORY : 0);
  try {
    return openSync(target, flags);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }
    // O_NOFOLLOW reports a symlinked final component as ELOOP, or EMLINK on some BSDs.
    if (hasErrnoCode(error, "ELOOP") || hasErrnoCode(error, "EMLINK")) {
      stateDbLog.warn(`skipped permission restore for ${target}: symbolic link`);
      return undefined;
    }
    // Admission needs to read the object, which a foreign owner or a mode
    // without owner-read refuses. Permission hardening stays best-effort and
    // must not take the gateway down (#91919); the store's own owner still
    // decides whether this process may use it.
    if (hasErrnoCode(error, "EACCES") || hasErrnoCode(error, "EPERM")) {
      if (!chmodWarnedTargets.check(target)) {
        stateDbLog.warn(`skipped permission restore for ${target}: ${String(error)}`);
      }
      return undefined;
    }
    throw error;
  }
}

/** True while the descriptor and the pathname still name one filesystem object. */
function describesSamePathSync(fd: number, target: string): boolean {
  try {
    const opened = fstatSync(fd, { bigint: true });
    const named = lstatSync(target, { bigint: true });
    return opened.dev === named.dev && opened.ino === named.ino;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

/**
 * Restores one admitted, installation-owned object through its descriptor.
 *
 * Deliberately narrow, so this stays a repair rather than a policy change:
 * foreign-owned objects are left alone, an already-private object is untouched
 * so its ctime stays stable, an object carrying world permission bits is left
 * for its owner to refuse because fsGroup never sets those, and a file with
 * more than one link is refused because its other name may sit outside this
 * installation, where this repair has no authority.
 *
 * Returns true when the object is admitted as this installation's own, so the
 * caller may go on to inspect what it contains.
 */
function restoreAdmittedModeSync(
  fd: number,
  target: string,
  mode: number,
  kind: "directory" | "file",
): boolean {
  const opened = fstatSync(fd, { bigint: true });
  if (kind === "directory" ? !opened.isDirectory() : !opened.isFile()) {
    stateDbLog.warn(`skipped permission restore for ${target}: not a regular ${kind}`);
    return false;
  }
  if (!describesSamePathSync(fd, target)) {
    return false;
  }
  if (kind === "file" && opened.nlink !== 1n) {
    stateDbLog.warn(`skipped permission restore for ${target}: more than one link`);
    return false;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && opened.uid !== BigInt(uid)) {
    return false;
  }
  const bits = opened.mode & 0o7777n;
  if ((bits & 0o007n) !== 0n) {
    return false;
  }
  if ((bits & 0o7070n) === 0n) {
    return true;
  }
  bestEffortFchmodSync(fd, target, mode);
  return true;
}

/**
 * Restores a store directory, then the database files it is admitted to hold.
 *
 * Admitting the directory decides whether its children may be touched at all:
 * a refused directory may be an alias, and a pathname below it would resolve
 * through that alias to an object this installation does not own.
 */
function restoreStoreDirectorySync(directory: string, files: readonly string[]): void {
  const directoryFd = openStorePathSync(directory, true);
  if (directoryFd === undefined) {
    return;
  }
  try {
    if (!restoreAdmittedModeSync(directoryFd, directory, OPENCLAW_STATE_DIR_MODE, "directory")) {
      return;
    }
    for (const file of files) {
      for (const candidate of resolveSqliteDatabaseFilePaths(path.join(directory, file))) {
        // A pathname below the admitted directory is only safe while that
        // directory still occupies the path it was admitted at.
        if (!describesSamePathSync(directoryFd, directory)) {
          return;
        }
        const fileFd = openStorePathSync(candidate, false);
        if (fileFd === undefined) {
          continue;
        }
        try {
          restoreAdmittedModeSync(fileFd, candidate, OPENCLAW_STATE_FILE_MODE, "file");
        } finally {
          closeSync(fileFd);
        }
      }
    }
  } finally {
    closeSync(directoryFd);
  }
}

/**
 * Restores private modes that an fsGroup volume remount broadens.
 *
 * Kubernetes re-applies `fsGroup` group permissions to every directory and file
 * of a volume on each mount, and Linux propagates the volume's setgid bit into
 * directories the gateway creates under it. The private-storage owners then
 * refuse to open state this installation already owns, and the Gateway cannot
 * start (#192959). `fsGroupChangePolicy: OnRootMismatch` only narrows when this
 * will happen; it does not restore permissions already broadened.
 *
 * This repairs an enumerated set of owned paths before those owners run, so
 * every downstream admission check stays exactly as strict as before.
 */
export function restorePrivateStateStoreModes(env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") {
    return;
  }
  // The state root itself is deliberately left alone: a shared, group-accessible
  // state root is a supported layout, and config publication preserves its mode
  // (src/config/io.write-config.test.ts). Only the private stores under and
  // beside it must be private.
  const stateDir = path.resolve(resolveStateDir(env));
  restoreStoreDirectorySync(`${stateDir}${UPDATE_CAPTURE_ROOT_SUFFIX}`, []);
  for (const [directory, file] of PRIVATE_STATE_STORES) {
    restoreStoreDirectorySync(path.join(stateDir, directory), [file]);
  }
}

export function ensureOpenClawStatePermissions(
  pathname: string,
  env: NodeJS.ProcessEnv,
  options: { createDirectory?: boolean } = {},
): void {
  const dir = path.dirname(pathname);
  const defaultPath = resolveOpenClawStateSqlitePath(env);
  const defaultDir = path.dirname(defaultPath);
  const isDefaultStateDatabase = path.resolve(pathname) === path.resolve(defaultPath);
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  // A custom database path owns no sibling private stores, so only the default
  // installation's own paths are restored.
  if (isDefaultStateDatabase) {
    restorePrivateStateStoreModes(env);
  }
  const dirExisted = existsSync(dir);
  if (options.createDirectory) {
    mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  }
  // Default state contains credentials-adjacent metadata; custom existing dirs keep caller modes.
  if (isDefaultStateDatabase || !dirExisted) {
    bestEffortChmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      try {
        bestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
      } catch (error) {
        // SQLite removes -wal/-shm at checkpoint or close, so a concurrent opener
        // can delete a sidecar between this check and the chmod. A vanished sidecar
        // has nothing left to harden. The main database keeps its fail-loud
        // boundary: swallowing its ENOENT would fall through to an open that
        // creates a fresh empty database instead of surfacing the loss.
        if (candidate === pathname || !hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
}
