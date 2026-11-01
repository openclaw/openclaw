import { createTestEntrypoint } from "./runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "infra");

// Native storage probes share the invocation build before their child deadlines begin.
export const storageProcessTestEntrypoints = {
  nodeSqlite: entrypoint("node-sqlite"),
  sqliteRuntimeInitialize: entrypoint("sqlite-runtime-initialize"),
  auditRecovery: entrypoint("state-migrations.audit-recovery-protocol.test-support"),
  acpMetadataWriter: entrypoint(
    "../acp/runtime/session-meta-process.test-support",
    "acp/runtime/session-meta-process.test-support.js",
  ),
  deviceIdentity: entrypoint("device-identity"),
  deviceIdentityStore: entrypoint("device-identity-store"),
  kyselySync: entrypoint("kysely-sync"),
  updateDoctorResult: entrypoint("update-doctor-result"),
  updateModelRetirement: entrypoint("update-deferred-model-retirement"),
  sqliteReadOnlyLocation: entrypoint("sqlite-readonly-location"),
  sqliteReadRetention: entrypoint("sqlite-readonly-worker.retention.test-support"),
  sqliteSchemaRetention: entrypoint("sqlite-schema-facts.retention.test-support"),
  sqliteLifecycleCreationRetention: entrypoint("sqlite-lifecycle-creation.retention.test-support"),
  lifecycleTimerRetention: entrypoint("lifecycle-timer-retention.test-support"),
  queueTimerRetention: entrypoint("queue-timer-retention.test-support"),
  lifecycleTailRetention: entrypoint("lifecycle-tail-retention.test-support"),
  sharedStateWalFixture: entrypoint(
    "../state/openclaw-state-worker-wal.test-support",
    "state/openclaw-state-worker-wal.test-support.js",
  ),
} as const;
