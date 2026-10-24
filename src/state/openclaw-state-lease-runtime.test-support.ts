// Compile once per test invocation so process-exit proof uses packaged worker startup.
export const stateLeaseProcessExitRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-state-lease-process-exit-child.test-support",
  distWorkerPath: "state/openclaw-state-lease-process-exit-child.test-support.js",
} as const;

export const stateLeaseRetentionRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-state-lease.retention.test-support",
  distWorkerPath: "state/openclaw-state-lease.retention.test-support.js",
} as const;

export const agentDatabaseHeldRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-agent-db-held-child.test-support",
  distWorkerPath: "state/openclaw-agent-db-held-child.test-support.js",
} as const;

export const agentDeletionRecoveryHoldPostgresRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "agent-deletion-recovery-hold.postgres.test-support",
  distWorkerPath: "state/agent-deletion-recovery-hold.postgres.test-support.js",
} as const;

export const cronOwnerInspectionPostgresRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "cron-owner-inspection.postgres.test-support",
  distWorkerPath: "state/cron-owner-inspection.postgres.test-support.js",
} as const;

export const stateLeasePostgresRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "openclaw-state-lease.postgres.test-support",
  distWorkerPath: "state/openclaw-state-lease.postgres.test-support.js",
} as const;
