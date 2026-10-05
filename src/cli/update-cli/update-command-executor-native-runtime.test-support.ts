// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

export const updateExecutorNativeEntrypoints = {
  gatewayLock: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/gateway-lock",
    distWorkerPath: "infra/gateway-lock.js",
  },
  databaseGenerations: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-database-generations",
    distWorkerPath: "infra/update-database-generations.js",
  },
  postUpdate: {
    currentModuleUrl,
    sourceWorkerName: "update-command-post-update",
    distWorkerPath: "cli/update-cli/update-command-post-update.js",
  },
  candidateState: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-candidate-state",
    distWorkerPath: "infra/update-candidate-state.js",
  },
  candidateStateWorker: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-candidate-state.worker",
    distWorkerPath: "infra/update-candidate-state.worker.js",
  },
  systemdMaintenance: {
    currentModuleUrl,
    sourceWorkerName: "../../daemon/systemd-maintenance",
    distWorkerPath: "daemon/systemd-maintenance.js",
  },
  serviceDrain: {
    currentModuleUrl,
    sourceWorkerName: "update-command-service-drain",
    distWorkerPath: "cli/update-cli/update-command-service-drain.js",
  },
  serviceMembership: {
    currentModuleUrl,
    sourceWorkerName: "../../daemon/service-process-membership",
    distWorkerPath: "daemon/service-process-membership.js",
  },
  serviceMaintenance: {
    currentModuleUrl,
    sourceWorkerName: "update-command-service-maintenance",
    distWorkerPath: "cli/update-cli/update-command-service-maintenance.js",
  },
  artifact: {
    currentModuleUrl,
    sourceWorkerName: "update-command-artifact",
    distWorkerPath: "cli/update-cli/update-command-artifact.js",
  },
  commandCleanup: {
    currentModuleUrl,
    sourceWorkerName: "../../process/exec-result",
    distWorkerPath: "process/exec-result.js",
  },
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
  candidateStepWriter: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-run-write.async",
    distWorkerPath: "infra/update-run-write.async.js",
  },
  executionGuards: {
    currentModuleUrl,
    sourceWorkerName: "update-command-execution-guards",
    distWorkerPath: "cli/update-cli/update-command-execution-guards.js",
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
  doctorCustody: {
    currentModuleUrl,
    sourceWorkerName: "../../infra/update-doctor-process-custody",
    distWorkerPath: "infra/update-doctor-process-custody.js",
  },
  processSpawn: {
    currentModuleUrl,
    sourceWorkerName: "../../process/exec-spawn",
    distWorkerPath: "process/exec-spawn.js",
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
  includeDelegated: {
    currentModuleUrl,
    sourceWorkerName: "update-command-include-delegated.test-support",
    distWorkerPath: "test-support/update-include-delegated.js",
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
