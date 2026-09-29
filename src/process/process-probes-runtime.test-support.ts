export const processProbeEntrypoints = {
  serviceChildSubreaper: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "supervisor/service-child-subreaper.test-support",
    distWorkerPath: "process/supervisor/service-child-subreaper.test-support.js",
  },
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
