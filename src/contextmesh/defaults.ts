import type { ContextMeshState } from "./types.js";

export function defaultContextMeshState(): ContextMeshState {
  return {
    config: {
      protocolVersion: "contextmesh-v1",
      allowSensitiveDistribution: false,
      privacyMode: "trusted_lan",
      maxChunkTokens: 1200,
      maxJobChars: 4_000_000,
      heartbeatTimeoutMs: 30_000,
      taskTimeoutMs: 60_000,
    },
    workers: [],
    jobs: [],
    tasks: [],
    audit: [],
    metrics: {
      connectedWorkers: 0,
      activeWorkers: 0,
      totalJobs: 0,
      activeJobs: 0,
      completedTasks: 0,
      failedTasks: 0,
      retries: 0,
      averageTaskLatencyMs: 0,
      estimatedTokensProcessed: 0,
      estimatedTokensPerSecond: 0,
      distributedSpeedupRatio: 1,
    },
  };
}
