// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

export const updateExecutorNativeEntrypoints = {
  commandRun: {
    currentModuleUrl,
    sourceWorkerName: "update-command-run",
    distWorkerPath: "cli/update-cli/update-command-run.js",
  },
  retainedRecovery: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-retained-recovery.test-support",
    distWorkerPath: "infra/update-retained-recovery.test-support.js",
  },
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
  configIO: {
    currentModuleUrl,
    sourceWorkerName: "../../config/io.factory",
    distWorkerPath: "config/io.factory.js",
  },
} as const;
