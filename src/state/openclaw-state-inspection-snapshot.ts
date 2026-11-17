import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";

/**
 * Inspection reports read every section from one private image, taken when a reader first
 * needs bytes. Per-read copies repeat the whole database whenever a live writer commits.
 */
export function withArtifactPreservingStateSnapshot<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(operation, { lazy: true, signal }),
  );
}
