import type { DatabaseFileIdentity } from "../infra/sqlite-worker-identity.js";
import type { PreparedCanonicalSessionValidationSchema } from "../state/openclaw-agent-canonical-validation-schema.js";

export type TrajectoryRuntimeRetentionInput = { sessionId: string; maxGlobalRuntimeBytes?: number };

export function readTrajectoryRuntimeRetentionLease(attachment: unknown): Int32Array {
  if (
    typeof attachment !== "object" ||
    attachment === null ||
    !("trajectoryRetentionLease" in attachment) ||
    !(attachment.trajectoryRetentionLease instanceof SharedArrayBuffer) ||
    attachment.trajectoryRetentionLease.byteLength !== 4
  ) {
    throw new Error("Trajectory retention lease is unavailable");
  }
  return new Int32Array(attachment.trajectoryRetentionLease);
}

export type TrajectoryRuntimeRetentionPlan = {
  cutoff: number;
  maxBytes: number;
  sessionId: string;
  runs: {
    sessionId: string;
    runId: string | null;
    newest: number;
    bytes: number;
    events: number;
    order: string;
  }[];
};

export type TrajectoryRetentionWorkerInput = {
  kind: "trajectory-retention";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  expectedIdentity: DatabaseFileIdentity;
  input: TrajectoryRuntimeRetentionInput;
  now: number;
  schemaContract?: PreparedCanonicalSessionValidationSchema;
};
