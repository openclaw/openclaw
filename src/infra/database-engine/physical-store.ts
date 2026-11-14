import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import { runSqliteReadOnlyWorkerSync } from "../sqlite-readonly-worker.js";
import type { BackupEngine } from "./types.js";

/** Source opens and closes stay in a child to preserve the caller's live POSIX locks. */
export function readBackupEngine(sourcePath: string): BackupEngine {
  return runSqliteReadOnlyWorkerSync(
    sourcePath,
    undefined,
    isArtifactPreservingStateRead("shared", sourcePath)
      ? "backup-engine-preserving"
      : "backup-engine",
  );
}
