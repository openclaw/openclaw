export const processProbeEntrypoints = {
  commandQueue: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "command-queue",
    distWorkerPath: "process/command-queue.js",
  },
  idleSupervisor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "supervisor/supervisor.idle-host.test-support",
    distWorkerPath: "process/supervisor/supervisor.idle-host.test-support.js",
  },
} as const;
