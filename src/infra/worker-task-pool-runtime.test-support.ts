// Prepare native subprocesses and their worker fixtures before their execution deadlines.
export const workerTaskPoolEntrypoints = {
  nativeExchanges: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.native-exchanges.test-support",
    distWorkerPath: "infra/worker-task-pool.native-exchanges.test-support.js",
  },
  nativeSections: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.native-sections.test-support",
    distWorkerPath: "infra/worker-task-pool.native-sections.test-support.js",
  },
  headless: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.headless.test-support",
    distWorkerPath: "infra/worker-task-pool.headless.test-support.js",
  },
  inputRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.retention.test-support",
    distWorkerPath: "infra/worker-task-pool.retention.test-support.js",
  },
  replyRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.reply-retention.test-support",
    distWorkerPath: "infra/worker-task-pool.reply-retention.test-support.js",
  },
  worker: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "worker-task-pool.test-support",
    distWorkerPath: "infra/worker-task-pool.test-support.js",
  },
} as const;
