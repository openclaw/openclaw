export type TrajectoryRuntimeRetentionInput = { sessionId: string; maxGlobalRuntimeBytes?: number };

export type TrajectoryRuntimeRetentionLease = { trajectoryRetentionLease: SharedArrayBuffer };

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

export type TrajectoryRuntimeRetentionReadOperations = {
  "trajectoryRetention.read": {
    input: TrajectoryRuntimeRetentionInput & { agentId: string; now: number };
    output: TrajectoryRuntimeRetentionPlan;
  };
};
