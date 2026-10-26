import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
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
