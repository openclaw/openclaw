import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RecoveryCleanupProgress = {
  phase: "verifying" | "claiming" | "removing-capture" | "removing-unmanifested";
  path: string;
  index: number;
  total: number;
  bytes: number;
};

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

export type RecoveryCleanupReport = {
  stateDir: string;
  artifacts: RecoveryCleanupArtifact[];
  totals: {
    candidateBytes: number;
    verificationRequiredBytes: number;
    protectedBytes: number;
    blockedBytes: number;
    removedBytes: number;
    removedFiles: number;
  };
  status: "preview" | "refused" | "complete" | "blocked";
  missingOriginals: number;
};

export type RecoveryRetirementParams = {
  env: NodeJS.ProcessEnv;
  preview: RecoveryCleanupReport;
  readConfig(): Promise<OpenClawConfig>;
  confirm(report: RecoveryCleanupReport): Promise<boolean>;
  onProgress?: (progress: RecoveryCleanupProgress) => void;
  /** Automatic retirement leaves historical originals for explicit verified cleanup. */
  verifyHistorical?: boolean;
  /** Manual per-path consent only; automatic callers must leave this absent. */
  includeUnmanifested?: readonly string[];
  /** Manual exact selection; never inferred from ordinary cleanup consent. */
  retireSessionArchive?: readonly string[];
  archiveBackup?: string;
  acceptHistoryLoss?: boolean;
};
