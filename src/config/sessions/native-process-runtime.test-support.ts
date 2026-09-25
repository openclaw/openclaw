export const sessionNativeProcessEntrypoints = {
  accessor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "session-accessor",
    distWorkerPath: "config/sessions/session-accessor.js",
  },
  canonicalReadiness: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "session-canonical-validation-readiness",
    distWorkerPath: "config/sessions/session-canonical-validation-readiness.js",
  },
  databaseReadOnly: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../state/openclaw-agent-db-readonly-open",
    distWorkerPath: "state/openclaw-agent-db-readonly-open.js",
  },
  databaseValidation: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../state/openclaw-agent-db-validation-cache",
    distWorkerPath: "state/openclaw-agent-db-validation-cache.js",
  },
  databaseRegistry: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../state/openclaw-agent-db-registry",
    distWorkerPath: "state/openclaw-agent-db-registry.js",
  },
} as const;
