import path from "node:path";

/**
 * Paths that are known to change during a live backup and commonly trigger
 * tar EOF errors. These files are actively appended to (logs, sockets, pid
 * markers) while `tar.c()` is reading them, which races with the size recorded
 * at `lstat()` time.
 *
 * Skipping them is safe: they are either recreated on startup, are transient
 * by nature, or have durable equivalents elsewhere in state. Snapshotting a
 * partial tail of a live log has no restoration value.
 */

const VOLATILE_ANY_EXTENSIONS = new Set([".sock", ".pid", ".tmp", ".lock"]);

function normalizePosix(input: string): string {
  if (!input) {
    return input;
  }
  // Swap Windows-style separators, then collapse `.`/`..` segments so ancestry
  // checks cannot be bypassed by a path that traverses out of the anchor.
  return path.posix.normalize(input.replaceAll("\\", "/"));
}

function isUnder(childPosix: string, parentPosix: string): boolean {
  if (!parentPosix) {
    return false;
  }
  const p = parentPosix.endsWith("/") ? parentPosix : `${parentPosix}/`;
  return childPosix === parentPosix || childPosix.startsWith(p);
}

function hasExtension(filePosix: string, extensions: readonly string[]): boolean {
  const ext = path.posix.extname(filePosix).toLowerCase();
  return extensions.includes(ext);
}

export type VolatileFilterPlan = {
  /** Canonical state directories the filter should treat as volatile anchors. */
  stateDirs: string[];
};

/**
 * Returns true if the given absolute path should be skipped during backup
 * because it is a live-mutation target.
 *
 * Rules:
 *   - `{stateDir}/sessions/**`/`*.{jsonl,log}`
 *   - `{stateDir}/cron/runs/**`/`*.log`
 *   - `{stateDir}/logs/**`/`*.{jsonl,log}`
 *   - Any file matching `*.{sock,pid,tmp,lock}` anywhere under scope
 */
export function isVolatileBackupPath(absolutePath: string, plan: VolatileFilterPlan): boolean {
  if (!absolutePath) {
    return false;
  }
  const filePosix = normalizePosix(absolutePath);

  if (hasExtension(filePosix, [...VOLATILE_ANY_EXTENSIONS])) {
    return true;
  }

  for (const stateDir of plan.stateDirs) {
    if (!stateDir) {
      continue;
    }
    const stateDirPosix = normalizePosix(stateDir);

    const sessionsRoot = path.posix.join(stateDirPosix, "sessions");
    if (isUnder(filePosix, sessionsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
      return true;
    }

    const cronRunsRoot = path.posix.join(stateDirPosix, "cron", "runs");
    if (isUnder(filePosix, cronRunsRoot) && hasExtension(filePosix, [".log"])) {
      return true;
    }

    const logsRoot = path.posix.join(stateDirPosix, "logs");
    if (isUnder(filePosix, logsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
      return true;
    }
  }

  return false;
}
