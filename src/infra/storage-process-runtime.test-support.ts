// Native storage probes share the invocation build before their child deadlines begin.
export const storageProcessTestEntrypoints = {
  acpMetadataWriter: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../acp/runtime/session-meta-process.test-support",
    distWorkerPath: "acp/runtime/session-meta-process.test-support.js",
  },
  deviceIdentity: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "device-identity",
    distWorkerPath: "infra/device-identity.js",
  },
  deviceIdentityStore: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "device-identity-store",
    distWorkerPath: "infra/device-identity-store.js",
  },
  kyselySync: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "kysely-sync",
    distWorkerPath: "infra/kysely-sync.js",
  },
  sqliteReadOnlyLocation: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-readonly-location",
    distWorkerPath: "infra/sqlite-readonly-location.js",
  },
  sqliteReadRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-readonly-worker.retention.test-support",
    distWorkerPath: "infra/sqlite-readonly-worker.retention.test-support.js",
  },
  sqliteSchemaRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-schema-facts.retention.test-support",
    distWorkerPath: "infra/sqlite-schema-facts.retention.test-support.js",
  },
  sqliteLifecycleCreationRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-lifecycle-creation.retention.test-support",
    distWorkerPath: "infra/sqlite-lifecycle-creation.retention.test-support.js",
  },
  lifecycleTimerRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "lifecycle-timer-retention.test-support",
    distWorkerPath: "infra/lifecycle-timer-retention.test-support.js",
  },
  queueTimerRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "queue-timer-retention.test-support",
    distWorkerPath: "infra/queue-timer-retention.test-support.js",
  },
  lifecycleTailRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "lifecycle-tail-retention.test-support",
    distWorkerPath: "infra/lifecycle-tail-retention.test-support.js",
  },
  sharedStateIdleFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-worker-shared-state-idle-fixture.test-support",
    distWorkerPath: "infra/sqlite-worker-shared-state-idle-fixture.test-support.js",
  },
} as const;
