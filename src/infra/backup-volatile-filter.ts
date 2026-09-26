import path from "node:path";
import { isLegacyAuditMigrationBackupPath } from "./backup-audit-paths.js";

// These live-mutation paths are transient or have durable equivalents in state;
// archiving their changing bytes would race the size captured by the tar header.
const CHROMIUM_SINGLETON_FILES = new Set(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
const SQLITE_MEMORY_TRANSIENT_PATH_PATTERN =
  /(?:^|\/)(?:[^/]+\.sqlite\.(?:generation-(?:lock|writer)|reindex-lock)\.sqlite|[^/]+\.sqlite\.(?:backup|memory-reindex|tmp)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-wal|-shm|-journal)?$/iu;

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

/** Transient names apply to every selected backup root, not just OpenClaw state. */
export function isTransientBackupPath(filePath: string): boolean {
  return /.+\.(?:sock$|pid$|tmp(?:\.|$))/iu.test(path.posix.basename(normalizePosix(filePath)));
}

export function isTransientSqliteBackupPath(filePath: string): boolean {
  const normalizedPath = normalizePosix(filePath);
  return SQLITE_MEMORY_TRANSIENT_PATH_PATTERN.test(normalizedPath);
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

function isManagedBrowserSingletonPath(filePosix: string, stateDirPosix: string): boolean {
  const browserRoot = path.posix.join(stateDirPosix, "browser");
  if (!isUnder(filePosix, browserRoot)) {
    return false;
  }
  const parts = path.posix.relative(browserRoot, filePosix).split("/").filter(Boolean);
  return (
    parts.length === 3 && parts[1] === "user-data" && CHROMIUM_SINGLETON_FILES.has(parts[2] ?? "")
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
      if (
        isUnder(filePosix, stateDirPosix) &&
        isLegacyAuditMigrationBackupPath(filePosix, stateDirPosix)
      ) {
        return true;
      }
      if (isManagedBrowserSingletonPath(filePosix, stateDirPosix)) {
        return true;
      }

      for (const parts of [
        ["sandbox", "skills-workspaces"],
        // Rebuildable bundles bridge open Control UI documents across updates.
        ["cache", "control-ui-assets"],
        ["tmp", "plugin-captures"],
      ]) {
        if (isUnder(filePosix, path.posix.join(stateDirPosix, ...parts))) {
          return true;
        }
      }

      if (
        hasExtension(filePosix, [".jsonl", ".log"]) &&
        (isAgentSessionTranscriptPath(filePosix, stateDirPosix) ||
          [["sessions"], ["cron", "runs"], ["logs"]].some((parts) =>
            isUnder(filePosix, path.posix.join(stateDirPosix, ...parts)),
          ))
      ) {
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

      if (isUnder(filePosix, stateDirPosix) && isTransientBackupPath(filePosix)) {
        return true;
      }
    }
  }

  return false;
}
