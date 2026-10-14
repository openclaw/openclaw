export const nativeWorkerTestEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "native-worker.integration.test-support",
  distWorkerPath: "worker/native-worker.integration.test-support.js",
} as const;
