// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

export const updateExecutorNativeEntrypoints = {
  signalExitBarrier: {
    currentModuleUrl,
    sourceWorkerName: "../signal-exit-barrier",
    distWorkerPath: "cli/signal-exit-barrier.js",
  },
  retainedService: {
    currentModuleUrl,
    sourceWorkerName: "update-command-retained-service",
    distWorkerPath: "cli/update-cli/update-command-retained-service.js",
  },
  sealedRuntime: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/sealed-runtime-registry",
    distWorkerPath: "infra/sealed-runtime-registry.js",
  },
  commandRun: {
    currentModuleUrl,
    sourceWorkerName: "update-command-run",
    distWorkerPath: "cli/update-cli/update-command-run.js",
  },
  commandTarget: {
    currentModuleUrl,
    sourceWorkerName: "update-command-target",
    distWorkerPath: "cli/update-cli/update-command-target.js",
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
  commandConfig: {
    currentModuleUrl,
    sourceWorkerName: "update-command-config",
    distWorkerPath: "cli/update-cli/update-command-config.js",
  },
  config: {
    currentModuleUrl,
    sourceWorkerName: "../../config/config",
    distWorkerPath: "config/config.js",
  },
  migratedFinalize: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-migrated-finalize.worker",
    distWorkerPath: "infra/update-migrated-finalize.worker.js",
  },
  doctorResult: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-doctor-result",
    distWorkerPath: "infra/update-doctor-result.js",
  },
  processExec: {
    currentModuleUrl,
    sourceWorkerName: "../../process/exec",
    distWorkerPath: "process/exec.js",
  },
  handoffLease: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-managed-service-handoff-lease",
    distWorkerPath: "infra/update-managed-service-handoff-lease.js",
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
  leaseFixture: {
    currentModuleUrl,
    sourceWorkerName: "update-command-lease.test-support",
    distWorkerPath: "cli/update-cli/update-command-lease.test-support.js",
  },
  failureOutput: {
    currentModuleUrl,
    sourceWorkerName: "../failure-output",
    distWorkerPath: "cli/failure-output.js",
  },
  sealedRegistry: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/sealed-runtime-registry",
    distWorkerPath: "infra/sealed-runtime-registry.js",
  },
} as const;
