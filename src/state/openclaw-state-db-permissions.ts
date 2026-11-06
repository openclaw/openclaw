import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { hasErrnoCode } from "../infra/errno.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
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

/**
 * Restores the private mode of one enumerated, installation-owned path.
 *
 * Deliberately narrow, so this stays a repair rather than a policy change:
 * symlinks are skipped instead of followed, foreign-owned paths are left alone,
 * an already-private path is untouched so its ctime stays stable, and a path
 * carrying world permission bits is left for its owner to refuse because
 * fsGroup never sets those.
 */
function restorePrivateStoreMode(target: string, mode: number): void {
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(target);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return;
    }
    throw error;
  }
  if (observed.isSymbolicLink()) {
    stateDbLog.warn(`skipped permission restore for ${target}: symbolic link`);
    return;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && observed.uid !== uid) {
    return;
  }
  if ((observed.mode & 0o007) !== 0 || (observed.mode & 0o7070) === 0) {
    return;
  }
  bestEffortChmodSync(target, mode);
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
  restorePrivateStoreMode(`${stateDir}${UPDATE_CAPTURE_ROOT_SUFFIX}`, OPENCLAW_STATE_DIR_MODE);
  for (const [directory, file] of PRIVATE_STATE_STORES) {
    restorePrivateStoreMode(path.join(stateDir, directory), OPENCLAW_STATE_DIR_MODE);
    for (const candidate of resolveSqliteDatabaseFilePaths(path.join(stateDir, directory, file))) {
      restorePrivateStoreMode(candidate, OPENCLAW_STATE_FILE_MODE);
    }
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
