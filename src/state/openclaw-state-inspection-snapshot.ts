import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";

/**
 * Inspection reports read live-owned SQLite directly and share one private image offline.
 * Sections that read after the report's own write must request a current read.
 */
export function withArtifactPreservingStateSnapshot<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(operation, { lazy: true, signal, preferLiveOwner: true }),
  );
}
