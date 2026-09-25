// Native state probes share the invocation's compiled graph before starting child deadlines.
export const stateNativeProcessEntrypoints = {
  clawPackageLifecycleLease: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "claw-package-lifecycle-lease",
    distWorkerPath: "state/claw-package-lifecycle-lease.js",
  },
  agentDatabase: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "openclaw-agent-db",
    distWorkerPath: "state/openclaw-agent-db.js",
  },
  stateDatabase: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "openclaw-state-db",
    distWorkerPath: "state/openclaw-state-db.js",
  },
  stateDatabaseCache: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "openclaw-state-db-cache",
    distWorkerPath: "state/openclaw-state-db-cache.js",
  },
  stateDatabaseContract: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "openclaw-state-db-contract",
    distWorkerPath: "state/openclaw-state-db-contract.js",
  },
  stateLease: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "openclaw-state-lease",
    distWorkerPath: "state/openclaw-state-lease.js",
  },
  loggingState: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../logging/state",
    distWorkerPath: "logging/state.js",
  },
  stateDatabaseCoordinator: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/state-database-coordinator",
    distWorkerPath: "infra/state-database-coordinator.js",
  },
  boundaryPath: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/boundary-path",
    distWorkerPath: "infra/boundary-path.js",
  },
  cryptoDigest: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/crypto-digest",
    distWorkerPath: "infra/crypto-digest.js",
  },
  sqliteCoordinator: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/sqlite-coordinator",
    distWorkerPath: "infra/sqlite-coordinator.js",
  },
  sqliteReadOnlyLocation: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/sqlite-readonly-location",
    distWorkerPath: "infra/sqlite-readonly-location.js",
  },
  nodeSqlite: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/node-sqlite",
    distWorkerPath: "infra/node-sqlite.js",
  },
} as const;
