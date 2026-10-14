export type RecoveryCleanupArtifact = {
  /** Absent for session migration originals; captures are whole update-capture directories. */
  kind?: "update-capture";
  path: string;
  runs: string[];
  bytes: number;
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
