import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";

/**
 * Inspection reports read every section from one private image, taken when a reader first
 * needs bytes. Per-read copies repeat the whole database whenever a live writer commits.
 * Sections that read after the report's own write must request a current read; concurrent
 * sections (update status's recovery sets beside its healing reconciliation) may show the
 * pre-write view until the next report, as they could already race that write.
 */
export function withArtifactPreservingStateSnapshot<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(operation, { lazy: true, signal }),
  );
}
