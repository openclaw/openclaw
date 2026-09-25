// The child probes share invocation-owned preparation and module state.
export const pluginProcessRuntimeEntrypoints = {
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
