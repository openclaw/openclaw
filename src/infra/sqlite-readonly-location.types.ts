import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";

export type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  cleanupAsync: () => Promise<boolean>;
  location: string;
  // The directory cleanup actually removes (dirname(location) without an explicit
  // owned root), so diagnostics name the retained path, not an already-deleted child.
  cleanupRoot?: string;
};

export type AsyncPreparedSqliteReadOnlyLocation = Omit<PreparedSqliteReadOnlyLocation, "cleanup">;

export type RetainedPreparedSqliteReadOnlyLocation = AsyncPreparedSqliteReadOnlyLocation & {
  startCleanup(): RetainedOperation<boolean>;
};

/** Result delivery does not discharge an accepted producer's cleanup custody. */
export type RetainedSqliteSnapshotPreparation =
  RetainedOperation<RetainedPreparedSqliteReadOnlyLocation> & {
    startClose(): RetainedOperation<void>;
  };
