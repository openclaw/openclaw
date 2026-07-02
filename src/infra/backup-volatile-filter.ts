// Filters volatile paths from backup manifests.
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

const STATE_RUNTIME_SUFFIXES = [".sock", ".pid", ".tmp"];
const STATE_TRANSIENT_SIDE_EFFECT_SUFFIXES = [
  ".lock",
  ".partial",
  ".journal",
  ".wal",
  ".shm",
  "-journal",
  "-wal",
  "-shm",
];
const AGENT_RUNTIME_VOLATILE_DIRS = new Set([
  ".tmp",
  "cache",
  "shell-snapshots",
  "shell_snapshots",
  "tmp",
]);
const BROWSER_USER_DATA_CACHE_DIRS = new Set([
  "Application Cache",
  "Cache",
  "CacheStorage",
  "Code Cache",
  "DawnCache",
  "GPUCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ScriptCache",
  "ShaderCache",
]);
const STATE_TRANSIENT_SIDE_EFFECT_ROOTS = [
  ".tmp",
  "cache",
  "delivery-queue",
  "downloads",
  "ipc",
  "locks",
  "run",
  "runs",
  "session-delivery-queue",
  "tmp",
];

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

function hasSuffixInSet(filePosix: string, suffixes: readonly string[]): boolean {
  const lower = filePosix.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function isSqliteSidecarPath(filePosix: string): boolean {
  const lower = filePosix.toLowerCase();
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    if (lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length).endsWith(".sqlite");
    }
  }
  return false;
}

function isUnderStateChild(filePosix: string, stateDirPosix: string, childName: string): boolean {
  return isUnder(filePosix, path.posix.join(stateDirPosix, childName));
}

function isAgentSessionTranscriptPath(filePosix: string, stateDirPosix: string): boolean {
  const agentsRoot = path.posix.join(stateDirPosix, "agents");
  if (!isUnder(filePosix, agentsRoot)) {
    return false;
  }
  const relative = path.posix.relative(agentsRoot, filePosix);
  const parts = relative.split("/").filter(Boolean);
  return parts.length >= 3 && parts[1] === "sessions";
}

function isAgentRuntimeVolatilePath(filePosix: string, stateDirPosix: string): boolean {
  const agentsRoot = path.posix.join(stateDirPosix, "agents");
  if (!isUnder(filePosix, agentsRoot)) {
    return false;
  }
  const relative = path.posix.relative(agentsRoot, filePosix);
  const parts = relative.split("/").filter(Boolean);
  return parts.length >= 3 && parts[1] === "agent" && AGENT_RUNTIME_VOLATILE_DIRS.has(parts[2]);
}

function isBrowserUserDataCachePath(filePosix: string, stateDirPosix: string): boolean {
  const browserRoot = path.posix.join(stateDirPosix, "browser");
  if (!isUnder(filePosix, browserRoot)) {
    return false;
  }
  const relative = path.posix.relative(browserRoot, filePosix);
  const parts = relative.split("/").filter(Boolean);
  const userDataIndex = parts.indexOf("user-data");
  if (userDataIndex === -1) {
    return false;
  }
  const userDataParts = parts.slice(userDataIndex + 1);
  if (userDataParts.some((part) => BROWSER_USER_DATA_CACHE_DIRS.has(part))) {
    return true;
  }
  const webApplicationsIndex = userDataParts.indexOf("Web Applications");
  return (
    webApplicationsIndex !== -1 &&
    userDataParts.slice(webApplicationsIndex + 1).includes("Resources")
  );
}

function isStateTransientSideEffectPath(filePosix: string, stateDirPosix: string): boolean {
  if (
    isSqliteSidecarPath(filePosix) ||
    !hasSuffixInSet(filePosix, STATE_TRANSIENT_SIDE_EFFECT_SUFFIXES)
  ) {
    return false;
  }
  return STATE_TRANSIENT_SIDE_EFFECT_ROOTS.some((root) =>
    isUnderStateChild(filePosix, stateDirPosix, root),
  );
}

function filePathCandidates(input: string): string[] {
  const normalized = normalizePosix(input);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return [normalized];
  }
  // node-tar may pass absolute input paths to filters without the leading
  // slash, even when the source list used absolute paths.
  return [normalized, normalizePosix(`/${normalized}`)];
}

type VolatileFilterPlan = {
  /** Canonical state directories the filter should treat as volatile anchors. */
  stateDirs: string[];
};

/**
 * Returns true if the given absolute path should be skipped during backup
 * because it is disposable runtime/cache state or a live-mutation target.
 *
 * Rules:
 *   - `{stateDir}/sessions/**`/`*.{jsonl,log}` (legacy)
 *   - `{stateDir}/agents/<agentId>/sessions/**`/`*.{jsonl,log}`
 *   - `{stateDir}/agents/<agentId>/agent/{tmp,.tmp,cache,shell-snapshots,shell_snapshots}/**`
 *   - `{stateDir}/cache/{shell-snapshots,shell_snapshots}/**`
 *   - browser user-data cache directories such as `Cache`, `Code Cache`, and `GPUCache`
 *   - `{stateDir}/archived/**`
 *   - `{stateDir}/cron/runs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/logs/**`/`*.{jsonl,log}`
 *   - `{stateDir}/{delivery-queue,session-delivery-queue}/**`/`*.{json,delivered,tmp}`
 *   - `{stateDir}/**`/`*.{sock,pid,tmp}`
 *   - transient-root side effects such as cache/queue `*.{lock,partial,journal,wal,shm}`
 */
export function isVolatileBackupPath(absolutePath: string, plan: VolatileFilterPlan): boolean {
  if (!absolutePath) {
    return false;
  }
  const candidates = filePathCandidates(absolutePath);

  for (const stateDir of plan.stateDirs) {
    if (!stateDir) {
      continue;
    }
    const stateDirPosix = normalizePosix(stateDir);

    for (const filePosix of candidates) {
      const sessionsRoot = path.posix.join(stateDirPosix, "sessions");
      if (isUnder(filePosix, sessionsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      if (
        isAgentSessionTranscriptPath(filePosix, stateDirPosix) &&
        hasExtension(filePosix, [".jsonl", ".log"])
      ) {
        return true;
      }

      if (isAgentRuntimeVolatilePath(filePosix, stateDirPosix)) {
        return true;
      }

      for (const shellSnapshotDir of ["shell-snapshots", "shell_snapshots"]) {
        const shellSnapshotRoot = path.posix.join(stateDirPosix, "cache", shellSnapshotDir);
        if (isUnder(filePosix, shellSnapshotRoot)) {
          return true;
        }
      }

      if (isBrowserUserDataCachePath(filePosix, stateDirPosix)) {
        return true;
      }

      const archivedRoot = path.posix.join(stateDirPosix, "archived");
      if (isUnder(filePosix, archivedRoot)) {
        return true;
      }

      const cronRunsRoot = path.posix.join(stateDirPosix, "cron", "runs");
      if (isUnder(filePosix, cronRunsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      const logsRoot = path.posix.join(stateDirPosix, "logs");
      if (isUnder(filePosix, logsRoot) && hasExtension(filePosix, [".jsonl", ".log"])) {
        return true;
      }

      for (const queueDir of ["delivery-queue", "session-delivery-queue"]) {
        const queueRoot = path.posix.join(stateDirPosix, queueDir);
        if (
          isUnder(filePosix, queueRoot) &&
          hasExtension(filePosix, [".json", ".delivered", ".tmp"])
        ) {
          return true;
        }
      }

      if (isUnder(filePosix, stateDirPosix) && hasSuffixInSet(filePosix, STATE_RUNTIME_SUFFIXES)) {
        return true;
      }

      if (
        isUnder(filePosix, stateDirPosix) &&
        isStateTransientSideEffectPath(filePosix, stateDirPosix)
      ) {
        return true;
      }
    }
  }

  return false;
}
