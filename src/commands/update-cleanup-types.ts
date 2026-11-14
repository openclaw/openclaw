export type RecoveryCleanupArtifact = {
  /** Absent for session migration originals; captures are whole update-capture directories. */
  kind?: "update-capture";
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
