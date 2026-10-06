export type TrajectoryRuntimeRetentionInput = { sessionId: string; maxGlobalRuntimeBytes?: number };

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
