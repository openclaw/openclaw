export type RecoveryCleanupArtifact = {
  /**
   * Absent for session migration originals; captures are whole update-capture directories;
   * a displaced database is the `<db>.migrated-<runId>` family a rollback moved aside; a
   * database snapshot is an update's whole pre-migration `.databases` directory.
   */
  kind?: "update-capture" | "displaced-database" | "database-snapshot";
  captureSource?: "update" | "doctor";
  path: string;
  runs: string[];
  bytes: number;
  /** Stable timestamp for age display; not an eligibility or expiration rule. */
  modifiedAt?: string;
  outcome:
    | "candidate"
    | "verification-required"
    | "protected"
    | "blocked"
    | "removed"
    | "disposed"
    | "failed";
  reason: string;
  detail?: string;
  consequence?: string;
  removedBytes?: number;
};
