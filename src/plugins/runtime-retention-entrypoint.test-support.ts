// Compile plugin loading before the retention child's bounded GC checks.
export const pluginRuntimeRetentionEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "runtime.retention.test-support",
  distWorkerPath: "plugins/runtime.retention.test-support.js",
} as const;
