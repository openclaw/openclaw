// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

function entry<S extends string, D extends string>(sourceWorkerName: S, distWorkerPath: D) {
  return { currentModuleUrl, sourceWorkerName, distWorkerPath } as const;
}

export const updateExecutorNativeEntrypoints = {
  gatewayLock: entry("../../infra/gateway-lock", "infra/gateway-lock.js"),
  databaseGenerations: entry(
    "../../infra/update-database-generations",
    "infra/update-database-generations.js",
  ),
  postUpdate: entry("update-command-post-update", "cli/update-cli/update-command-post-update.js"),
  terminal: entry("update-command-terminal", "cli/update-cli/update-command-terminal.js"),
  packageSwapFixture: entry(
    "../../infra/package-update-swap.test-support",
    "infra/package-update-swap.test-support.js",
  ),
  packageSwap: entry("../../infra/package-update-swap", "infra/package-update-swap.js"),
  packageDistInventory: entry(
    "../../../scripts/lib/package-dist-inventory",
    "scripts/lib/package-dist-inventory.js",
  ),
  candidateState: entry("../../infra/update-candidate-state", "infra/update-candidate-state.js"),
  candidateStateWorker: entry(
    "../../infra/update-candidate-state.worker",
    "infra/update-candidate-state.worker.js",
  ),
  systemdMaintenance: entry("../../daemon/systemd-maintenance", "daemon/systemd-maintenance.js"),
  serviceDrain: entry(
    "update-command-service-drain",
    "cli/update-cli/update-command-service-drain.js",
  ),
  serviceMembership: entry(
    "../../daemon/service-process-membership",
    "daemon/service-process-membership.js",
  ),
  serviceMaintenance: entry(
    "update-command-service-maintenance",
    "cli/update-cli/update-command-service-maintenance.js",
  ),
  artifact: entry("update-command-artifact", "cli/update-cli/update-command-artifact.js"),
  commandCleanup: entry("../../process/exec-result", "process/exec-result.js"),
  cliCleanupScope: entry("../runtime-cleanup-scope", "cli/runtime-cleanup-scope.js"),
  oneShotExit: entry("../one-shot-exit", "cli/one-shot-exit.js"),
  signalExitBarrier: entry("../signal-exit-barrier", "cli/signal-exit-barrier.js"),
  retainedService: entry(
    "update-command-retained-service",
    "cli/update-cli/update-command-retained-service.js",
  ),
  sealedRuntime: entry("../../infra/sealed-runtime-registry", "infra/sealed-runtime-registry.js"),
  commandRun: entry("update-command-run", "cli/update-cli/update-command-run.js"),
  candidateStepWriter: entry(
    "../../infra/update-run-write.async",
    "infra/update-run-write.async.js",
  ),
  executionGuards: entry(
    "update-command-execution-guards",
    "cli/update-cli/update-command-execution-guards.js",
  ),
  commandTarget: entry("update-command-target", "cli/update-cli/update-command-target.js"),
  retainedRecovery: entry(
    "../../infra/update-retained-recovery.test-support",
    "infra/update-retained-recovery.test-support.js",
  ),
  executor: entry("update-command-executor", "cli/update-cli/update-command-executor.js"),
  migratedFinalize: entry(
    "../../infra/update-migrated-finalize.worker",
    "infra/update-migrated-finalize.worker.js",
  ),
  doctorResult: entry("../../infra/update-doctor-result", "infra/update-doctor-result.js"),
  doctorCustody: entry(
    "../../infra/update-doctor-process-custody",
    "infra/update-doctor-process-custody.js",
  ),
  processSpawn: entry("../../process/exec-spawn", "process/exec-spawn.js"),
  processExec: entry("../../process/exec", "process/exec.js"),
  handoffLease: entry(
    "../../infra/update-managed-service-handoff-lease",
    "infra/update-managed-service-handoff-lease.js",
  ),
  nativeExecutor: entry("../daemon-cli/update-executor", "cli/daemon-cli/update-executor.js"),
  nativeExec: entry("../../daemon/exec-file", "daemon/exec-file.js"),
  serviceFiles: entry("../../daemon/launchd-service-files", "daemon/launchd-service-files.js"),
  serviceAuthority: entry(
    "../../daemon/service-update-authority",
    "daemon/service-update-authority.js",
  ),
  includeDelegated: entry(
    "update-command-include-delegated.test-support",
    "test-support/update-include-delegated.js",
  ),
  configIO: entry("../../config/io.factory", "config/io.factory.js"),
  directoryObservation: entry(
    "../../infra/owned-directory-observation",
    "infra/owned-directory-observation.js",
  ),
  leaseFixture: entry(
    "update-command-lease.test-support",
    "cli/update-cli/update-command-lease.test-support.js",
  ),
  failureOutput: entry("../failure-output", "cli/failure-output.js"),
  sealedRegistry: entry("../../infra/sealed-runtime-registry", "infra/sealed-runtime-registry.js"),
} as const;
