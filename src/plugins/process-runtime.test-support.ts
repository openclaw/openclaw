// The child probes share invocation-owned preparation and module state.
export const pluginProcessRuntimeEntrypoints = {
  directoryInventory: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/directory-walk",
    distWorkerPath: "infra/directory-walk.js",
  },
  installCommand: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/plugins-install-command",
    distWorkerPath: "cli/plugins-install-command.js",
  },
  config: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/config",
    distWorkerPath: "config/config.js",
  },
  hookInstalls: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../hooks/installs",
    distWorkerPath: "hooks/installs.js",
  },
  installedPluginRecords: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "installed-plugin-index-records",
    distWorkerPath: "plugins/installed-plugin-index-records.js",
  },
  delegatedAuthority: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/agent-run-registry",
    distWorkerPath: "infra/agent-run-registry.js",
  },
  hooks: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "hooks",
    distWorkerPath: "plugins/hooks.js",
  },
  artifact: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-generation-artifact",
    distWorkerPath: "plugins/plugin-generation-artifact.js",
  },
  captureDirectory: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-source-capture-directory",
    distWorkerPath: "plugins/plugin-source-capture-directory.js",
  },
  doctorLintNativeCapture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../commands/doctor-lint.native-capture.test-support",
    distWorkerPath: "commands/doctor-lint.native-capture.test-support.js",
  },
  scheduler: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/gateway-scheduler",
    distWorkerPath: "infra/gateway-scheduler.js",
  },
  metadataCapture: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-package-metadata-capture",
    distWorkerPath: "plugins/plugin-package-metadata-capture.js",
  },
  signalExit: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/signal-exit-barrier",
    distWorkerPath: "cli/signal-exit-barrier.js",
  },
  cleanupScope: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/runtime-cleanup-scope",
    distWorkerPath: "cli/runtime-cleanup-scope.js",
  },
  publicSurfaceLoader: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "public-surface-loader",
    distWorkerPath: "plugins/public-surface-loader.js",
  },
  facadeLoader: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugin-sdk/facade-loader",
    distWorkerPath: "plugin-sdk/facade-loader.js",
  },
  metadataLifecycle: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-metadata-lifecycle",
    distWorkerPath: "plugins/plugin-metadata-lifecycle.js",
  },
} as const;
