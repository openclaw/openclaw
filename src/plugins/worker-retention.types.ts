/** Immutable acquisition policy. An observation or heartbeat never renews its work window. */
export type WorkerRetentionPolicy = {
  version: 1;
  ownerBinding: string;
  computeWindowSeconds: number;
};

/** Persist before submitting; retries keep all three fields unchanged. */
export type WorkerRetentionOperation = {
  id: string;
  action: "pause" | "resume";
  expectedClaimRevision: string;
};

/** Provider-normalized facts; unavailable observations do not authorize deletion or execution. */
export type WorkerRetentionObservation = {
  claimRevision: string;
  state: "running" | "suspended" | "transitioning" | "expired" | "unavailable";
  computeExpiresAtMs: number;
  operation?: WorkerRetentionOperation & { phase: "pending" | "observed" };
};

/** Environment writer owns policy, unfinished operation, and its latest observed facts. */
export type WorkerEnvironmentRetention = {
  policy: WorkerRetentionPolicy;
  /** Cleared before lifecycle effects; set only after exact-node runtime admission. */
  runtimeReady: boolean;
  operation: WorkerRetentionOperation | null;
  observation: WorkerRetentionObservation | null;
};
