/** Cron identity plus exact operation binding recorded at approval creation. */
export type CronStandingGrantMintSpec = {
  agentId: string;
  cronJobId: string;
  jobConfigRevision: string;
  operationBinding: string;
};

export type CronStandingGrantRecord = CronStandingGrantMintSpec & {
  grantId: string;
  mintedByApprovalId: string;
  createdAtMs: number;
  /** NULL means the grant lives until revoked or superseded. */
  expiresAtMs: number | null;
  lastUsedAtMs: number | null;
  useCount: number;
};

export type ConsumeCronStandingGrantResult =
  | { outcome: "consumed"; grant: CronStandingGrantRecord }
  | {
      outcome:
        | "no-grant"
        | "revoked"
        | "expired"
        | "job-missing"
        | "job-revision-changed"
        | "approval-missing"
        | "approval-not-allow-always";
    };

/** One grant row projected for operator surfaces (list, CLI, cards). */
export type CronStandingGrantListing = CronStandingGrantRecord & {
  /** Display name from the owning cron job row; null when the job is gone. */
  cronJobName: string | null;
  revokedAtMs: number | null;
  revokedBy: string | null;
};

export type RevokeCronStandingGrantResult =
  | { outcome: "revoked"; grant: CronStandingGrantListing }
  | { outcome: "already-revoked" }
  | { outcome: "not-found" };
