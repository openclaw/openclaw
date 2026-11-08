import path from "node:path";
import { isLegacyAuditMigrationBackupPath } from "./backup-audit-paths.js";

// These live-mutation paths are transient or have durable equivalents in state;
// archiving their changing bytes would race the size captured by the tar header.
const CHROMIUM_SINGLETON_FILES = new Set(["SingletonCookie", "SingletonLock", "SingletonSocket"]);
const VOLATILE_DIRECTORY_RULES = [
  // Older installs keep the obsolete Control UI cache until Doctor removes it.
  [["sandbox/skills-workspaces", "cache/control-ui-assets", "tmp/plugin-captures"], undefined],
  [
    ["sessions", "cron/runs", "logs"],
    [".jsonl", ".log"],
  ],
  [
    ["delivery-queue", "session-delivery-queue"],
    [".json", ".delivered", ".tmp"],
  ],
] as const;
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

function relativePathParts(filePosix: string, root: string): string[] {
  return isUnder(filePosix, root)
    ? path.posix.relative(root, filePosix).split("/").filter(Boolean)
    : [];
}

type VolatileFilterPlan = {
  /** Canonical state directories the filter should treat as volatile anchors. */
  stateDirs: string[];
};

export function isVolatileBackupPath(absolutePath: string, plan: VolatileFilterPlan): boolean {
  if (!absolutePath) {
    return false;
  }
  const filePosix = normalizePosix(absolutePath);

  for (const stateDir of plan.stateDirs) {
    if (!stateDir) {
      continue;
    }
    const stateDirPosix = normalizePosix(stateDir);

    if (
      isUnder(filePosix, stateDirPosix) &&
      isLegacyAuditMigrationBackupPath(filePosix, stateDirPosix)
    ) {
      return true;
    }
    const browserParts = relativePathParts(filePosix, path.posix.join(stateDirPosix, "browser"));
    if (
      browserParts.length === 3 &&
      browserParts[1] === "user-data" &&
      CHROMIUM_SINGLETON_FILES.has(browserParts[2] ?? "")
    ) {
      return true;
    }

    for (const [directories, extensions] of VOLATILE_DIRECTORY_RULES) {
      if (
        (!extensions || hasExtension(filePosix, extensions)) &&
        directories.some((directory) =>
          isUnder(filePosix, path.posix.join(stateDirPosix, directory)),
        )
      ) {
        return true;
      }
    }

    if (hasExtension(filePosix, [".jsonl", ".log"])) {
      const agentParts = relativePathParts(filePosix, path.posix.join(stateDirPosix, "agents"));
      if (agentParts.length >= 3 && agentParts[1] === "sessions") {
        return true;
      }
    }

    if (isUnder(filePosix, stateDirPosix) && isTransientBackupPath(filePosix)) {
      return true;
    }
  }

  return false;
}
