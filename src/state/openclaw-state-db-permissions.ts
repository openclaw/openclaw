import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { hasErrnoCode } from "../infra/errno.js";
import { applyPrivateModeSync, applyPrivateModeToFdSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";

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
// chmod failures still throw so credentials-adjacent hardening stays loud.
function bestEffortChmodSync(target: string, mode: number): void {
  const result = applyPrivateModeSync(target, mode);
  if (result.applied || chmodWarnedTargets.check(target)) {
    return;
  }
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

export function ensureOpenClawStatePermissions(
  pathname: string,
  env: NodeJS.ProcessEnv,
  options: { createDirectory?: boolean } = {},
): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  const isDefaultStateDatabase =
    path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
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

/** Restore only the existing capture root after Doctor has admitted its repair owner. */
export function restorePrivateUpdateCaptureRootMode(env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") {
    return;
  }
  // Never traverse the state tree or change the shared state root. The snapshot
  // owner still checks ancestors, aliases and ownership before capturing data.
  const target = resolveUpdateCaptureRoot(path.resolve(resolveStateDir(env)));
  let fd: number;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return;
    }
    if (
      hasErrnoCode(error, "ELOOP") ||
      hasErrnoCode(error, "EMLINK") ||
      hasErrnoCode(error, "EACCES") ||
      hasErrnoCode(error, "EPERM")
    ) {
      if (!chmodWarnedTargets.check(target)) {
        stateDbLog.warn(`skipped permission restore for ${target}: ${String(error)}`);
      }
      return;
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    let named: BigIntStats;
    try {
      named = lstatSync(target, { bigint: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        return;
      }
      throw error;
    }
    const uid = process.getuid?.();
    if (
      !opened.isDirectory() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      (uid !== undefined && opened.uid !== BigInt(uid)) ||
      (opened.mode & 0o007n) !== 0n ||
      (opened.mode & 0o7070n) === 0n
    ) {
      return;
    }
    const result = applyPrivateModeToFdSync(fd, target, OPENCLAW_STATE_DIR_MODE);
    if (!result.applied && !chmodWarnedTargets.check(target)) {
      stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
    }
  } finally {
    closeSync(fd);
  }
}
