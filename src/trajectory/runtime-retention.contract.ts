export type TrajectoryRuntimeRetentionInput = { sessionId: string; maxGlobalRuntimeBytes?: number };

export type TrajectoryRuntimeRetentionPlan = {
  complete: boolean;
  sessionId: string;
  runs: { sessionId: string; runId: string | null }[];
};

export type TrajectoryRuntimeRetentionReadOperations = {
  "trajectoryRetention.read": {
    input: TrajectoryRuntimeRetentionInput & { agentId: string; now: number };
    output: TrajectoryRuntimeRetentionPlan;
  };
};
