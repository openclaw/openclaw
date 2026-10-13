export const serviceProcessEnvEntrypoints = {
  systemdExec: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "systemd-exec",
    distWorkerPath: "daemon/systemd-exec.js",
  },
  systemdLinger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "systemd-linger",
    distWorkerPath: "daemon/systemd-linger.js",
  },
  systemdServiceFiles: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "systemd-service-files",
    distWorkerPath: "daemon/systemd-service-files.js",
  },
  serviceEnvMerge: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "service-env-merge",
    distWorkerPath: "daemon/service-env-merge.js",
  },
} as const;
