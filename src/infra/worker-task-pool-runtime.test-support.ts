import { createTestEntrypoint } from "./runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "infra");

// Prepare native subprocesses and their worker fixtures before their execution deadlines.
export const workerTaskPoolEntrypoints = {
  compileCacheParent: entrypoint("worker-task-pool.compile-cache-parent.test-support"),
  compileCacheWorker: entrypoint("worker-task-pool.compile-cache-worker.test-support"),
  failure: entrypoint("worker-task-pool.failure.test-support"),
  logging: entrypoint("worker-task-pool.logging.test-support"),
  nativeExchanges: entrypoint("worker-task-pool.native-exchanges.test-support"),
  nativeSections: entrypoint("worker-task-pool.native-sections.test-support"),
  headless: entrypoint("worker-task-pool.headless.test-support"),
  inputRetention: entrypoint("worker-task-pool.retention.test-support"),
  replyRetention: entrypoint("worker-task-pool.reply-retention.test-support"),
  worker: entrypoint("worker-task-pool.test-support"),
} as const;
