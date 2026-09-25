// Finite runs share the verified build; standalone/watch rebuilds the packaged fixture.
const currentModuleUrl = import.meta.url;

export const agentDatabaseModuleIdentityEntrypoints = {
  host: {
    currentModuleUrl,
    sourceWorkerName: "openclaw-agent-db-module-identity-host.test-support",
    distWorkerPath: "state/openclaw-agent-db-module-identity-host.test-support.js",
  },
  sdk: {
    currentModuleUrl,
    sourceWorkerName: "openclaw-agent-db-module-identity-sdk.test-support",
    distWorkerPath: "state/openclaw-agent-db-module-identity-sdk.test-support.js",
  },
} as const;
