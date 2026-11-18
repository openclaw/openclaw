import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "state");

// Compile once per test invocation so process-exit proof uses packaged worker startup.
export const stateLeaseProcessExitRuntimeEntrypoint = entrypoint(
  "openclaw-state-lease-process-exit-child.test-support",
);

export const stateLeaseRetentionRuntimeEntrypoint = entrypoint(
  "openclaw-state-lease.retention.test-support",
);

export const agentDatabaseHeldRuntimeEntrypoint = entrypoint(
  "openclaw-agent-db-held-child.test-support",
);

export const agentDeletionRecoveryHoldPostgresRuntimeEntrypoint = entrypoint(
  "agent-deletion-recovery-hold.postgres.test-support",
);

export const cronOwnerInspectionPostgresRuntimeEntrypoint = entrypoint(
  "cron-owner-inspection.postgres.test-support",
);

export const stateLeasePostgresRuntimeEntrypoint = entrypoint(
  "openclaw-state-lease.postgres.test-support",
);
