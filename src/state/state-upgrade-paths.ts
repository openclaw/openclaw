import path from "node:path";

// Copies an earlier upgrade or the retired in-place migration left behind.
export const RETIRED_BACKUP_NAME =
  /\.pre-startup-migration-|\.scoped\.bak$|\.sqlite[^/]*\.bak$|^openclaw-media-persistence-recovery-/u;
export const GENERATION_NAME = /\.pre-[^/]+$/u;
// SQLite companions the private copy folds in or the next open recreates.
const COMPANION_NAME = /-(wal|shm|journal)$|\.seal$/u;

export function skipEntry(name: string): boolean {
  return GENERATION_NAME.test(name) || RETIRED_BACKUP_NAME.test(name) || COMPANION_NAME.test(name);
}

/** Paths the frozen launcher can discover when restoring a prior generation. */
export function isUpgradeRestorePath(stateDir: string, file: string): boolean {
  const relative = path.relative(stateDir, file);
  const parts = relative.split(path.sep);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    parts.length <= 5 &&
    !parts.some(
      (part, index) =>
        skipEntry(part) ||
        (index < parts.length - 1 &&
          ["git-install", "npm", "node_modules", "tmp", "logs"].includes(part)),
    )
  );
}
