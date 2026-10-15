import type { ClawOpenClawAgentSettings } from "./manifest-contract.js";
import type { ClawCronJob } from "./schema.js";

export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: typeof CLAW_CRON_REF_SCHEMA_VERSION;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

// Reserved local ownership key, outside the portable cron id grammar. Not a cron declaration.
export const CLAW_PORTABLE_HEARTBEAT_ID = "$portable-heartbeat";
export type ClawPortableHeartbeat = NonNullable<ClawOpenClawAgentSettings["heartbeat"]>;
export type PersistedClawHeartbeatRef = Omit<PersistedClawCronRef, "job"> & {
  job: {
    heartbeat: ClawPortableHeartbeat;
    configRevision: string;
    scratchDigest?: string;
    sourceScratchDigest?: string;
    sourceAgentDigest?: string;
  };
};
