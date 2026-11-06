import path from "node:path";

// Each fresh child uses one compiled graph for its authority and effect owners.
const currentModuleUrl = import.meta.url;

function entry<S extends string>(
  sourceWorkerName: S,
  distWorkerPath = path.posix
    .normalize(`src/cli/update-cli/${sourceWorkerName}`)
    .replace(/^src\//, "") + ".js",
) {
  return { currentModuleUrl, sourceWorkerName, distWorkerPath } as const;
}

export const updateExecutorNativeEntrypoints = {
  gatewayLock: entry("../../infra/gateway-lock"),
  databaseGenerations: entry("../../infra/update-physical-database-generations"),
  postUpdate: entry("update-command-post-update"),
  resultOutput: entry("../update-result-output.test-support"),
  terminal: entry("update-command-terminal"),
  packageSwapFixture: entry("../../infra/package-update-swap.test-support"),
  packageSwap: entry("../../infra/package-update-swap"),
  packageDistInventory: entry("../../../scripts/lib/package-dist-inventory"),
  candidateState: entry("../../infra/update-candidate-state"),
  candidateStateWorker: entry("../../infra/update-candidate-state.worker"),
  systemdMaintenance: entry("../../daemon/systemd-maintenance"),
  serviceDrain: entry("update-command-service-drain"),
  serviceMembership: entry("../../daemon/service-process-membership"),
  serviceMaintenance: entry("update-command-service-maintenance"),
  artifact: entry("update-command-artifact"),
  commandCleanup: entry("../../process/exec-result"),
  cliCleanupScope: entry("../runtime-cleanup-scope"),
  oneShotExit: entry("../one-shot-exit"),
  signalExitBarrier: entry("../signal-exit-barrier"),
  retainedService: entry("update-command-retained-service"),
  sealedRuntime: entry("../../infra/sealed-runtime-registry"),
  commandRun: entry("update-command-run"),
  candidateStepWriter: entry("../../infra/update-run-write.async"),
  executionGuards: entry("update-command-execution-guards"),
  commandTarget: entry("update-command-target"),
  retainedRecovery: entry("../../infra/update-retained-recovery.test-support"),
  executor: entry("update-command-executor"),
  runLedger: entry("../../infra/update-run-ledger"),
  runDriver: entry("../../infra/update-run-driver"),
  migratedFinalize: entry("../../infra/update-migrated-finalize.worker"),
  doctorResult: entry("../../infra/update-doctor-result"),
  doctorCustody: entry("../../infra/update-doctor-process-custody"),
  processSpawn: entry("../../process/exec-spawn"),
  processExec: entry("../../process/exec"),
  handoffLease: entry("../../infra/update-managed-service-handoff-lease"),
  nativeExecutor: entry("../daemon-cli/update-executor"),
  nativeExec: entry("../../daemon/exec-file"),
  serviceFiles: entry("../../daemon/launchd-service-files"),
  serviceAuthority: entry("../../daemon/service-update-authority"),
  includeDelegated: entry(
    "update-command-include-delegated.test-support",
    "test-support/update-include-delegated.js",
  ),
  configIO: entry("../../config/io.factory"),
  directoryObservation: entry("../../infra/owned-directory-observation"),
  leaseFixture: entry("update-command-lease.test-support"),
  failureOutput: entry("../failure-output"),
  sealedRegistry: entry("../../infra/sealed-runtime-registry"),
} as const;
