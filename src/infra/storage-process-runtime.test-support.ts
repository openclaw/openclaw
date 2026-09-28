// Native storage probes share the invocation build before their child deadlines begin.
export const storageProcessTestEntrypoints = {
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
  sharedStateIdleFixture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sqlite-worker-shared-state-idle-fixture.test-support",
    distWorkerPath: "infra/sqlite-worker-shared-state-idle-fixture.test-support.js",
  },
} as const;
