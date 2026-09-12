// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

export const updateExecutorNativeEntrypoints = {
  executor: {
    currentModuleUrl,
    sourceWorkerName: "update-command-executor",
    distWorkerPath: "cli/update-cli/update-command-executor.js",
  },
  processExec: {
    currentModuleUrl,
    sourceWorkerName: "../../process/exec",
    distWorkerPath: "process/exec.js",
  },
  nativeExecutor: {
    currentModuleUrl,
    sourceWorkerName: "../daemon-cli/update-executor",
    distWorkerPath: "cli/daemon-cli/update-executor.js",
  },
  nativeExec: {
    currentModuleUrl,
    sourceWorkerName: "../../daemon/exec-file",
    distWorkerPath: "daemon/exec-file.js",
  },
  serviceFiles: {
    currentModuleUrl,
    sourceWorkerName: "../../daemon/launchd-service-files",
    distWorkerPath: "daemon/launchd-service-files.js",
  },
  serviceAuthority: {
    currentModuleUrl,
    sourceWorkerName: "../../daemon/service-update-authority",
    distWorkerPath: "daemon/service-update-authority.js",
  },
  doctorResult: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-doctor-result",
    distWorkerPath: "infra/update-doctor-result.js",
  },
  configIO: {
    currentModuleUrl,
    sourceWorkerName: "../../config/io.factory",
    distWorkerPath: "config/io.factory.js",
  },
} as const;
