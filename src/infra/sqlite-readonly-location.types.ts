import type { BigIntStats } from "node:fs";
import type { RetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import type { SqliteFileContent } from "./sqlite-snapshot-file.js";

/** Transient facts minted before an owned private family is exposed to readers. */
export type SqlitePrivateSnapshotFamily = { root: string; main: string; wal: string | null };

/** An allocated destination leaves token and directory retirement with its surviving owner. */
export type SqliteSnapshotDestination = string | { directory: string };

export type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  cleanupAsync: () => Promise<boolean>;
  location: string;
  // The directory cleanup actually removes (dirname(location) without an explicit
  // owned root), so diagnostics name the retained path, not an already-deleted child.
  cleanupRoot?: string;
  // Bound to the captured source digest, with no journal or WAL frames to apply.
  journalFreeContent?: SqliteFileContent & { identity: BigIntStats };
  // Only read-owned producers grant this before publishing bytes to any borrower.
  privateFamily?: SqlitePrivateSnapshotFamily;
};

/** Single-consumer custody of an exact image after its source observation settles. */
export type PreparedSqliteSnapshotSource = {
  sourcePath: string;
  prepared: PreparedSqliteReadOnlyLocation;
  family: SqlitePrivateSnapshotFamily;
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
