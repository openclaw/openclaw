// Compile together so child processes share Cron's database connection and command queue.
const currentModuleUrl = import.meta.url;

export const cronOwnerHardeningEntrypoints = {
  service: {
    currentModuleUrl,
    sourceWorkerName: "service",
    distWorkerPath: "cron/service.js",
  },
  stateDatabase: {
    currentModuleUrl,
    sourceWorkerName: "../state/openclaw-state-db",
    distWorkerPath: "state/openclaw-state-db.js",
  },
  commandQueue: {
    currentModuleUrl,
    sourceWorkerName: "../process/command-queue",
    distWorkerPath: "process/command-queue.js",
  },
} as const;
