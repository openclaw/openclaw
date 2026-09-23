export const nativeBoundaryTestEntrypoints = {
  unhandledRejections: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "unhandled-rejections",
    distWorkerPath: "infra/unhandled-rejections.js",
  },
  pluginHooks: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/hooks",
    distWorkerPath: "plugins/hooks.js",
  },
  emptyPluginRegistry: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/registry-empty",
    distWorkerPath: "plugins/registry-empty.js",
  },
  cliProfile: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/profile",
    distWorkerPath: "cli/profile.js",
  },
  handoffProcess: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-managed-service-handoff-process",
    distWorkerPath: "infra/update-managed-service-handoff-process.js",
  },
  handoffDatabase: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-managed-service-handoff-database",
    distWorkerPath: "infra/update-managed-service-handoff-database.js",
  },
} as const;
