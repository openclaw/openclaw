export { createBoundedLineFramer } from "../process/bounded-line-framer.js";
export { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
export { resolveNodeRuntimeExecutable } from "../infra/node-runtime-executable.js";
export { resolveLaunchableNodePath } from "../infra/stable-node-path.js";
export { splitCommandArgs } from "../utils/shell-argv.js";
export {
  type CommandOptions,
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandBuffered,
  runCommandWithTimeout,
  runUtf8CommandWithTimeout,
  runExec,
  shouldSpawnWithShell,
  type SpawnResult,
} from "../process/exec.js";
export { withCommandProcessScope } from "../process/exec-spawn.js";
export { prepareOomScoreAdjustedSpawn, spawnOomScoreAdjusted } from "../process/linux-oom-score.js";
export type { OomScoreAdjustedSpawn, OomWrapOptions } from "../process/linux-oom-score.js";
export { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
export { resolvePackageRuntimeProcessEntrypointUrl } from "../infra/runtime-process-package-url.js";
export { createPluginRuntimeProcessEntrypoint } from "../infra/runtime-process-manifest.js";
export {
  resolveRuntimeDependencyEntrypointUrl,
  resolvePluginRuntimeProcessAssetUrl,
} from "../infra/runtime-process-dependency-url.js";
export { createCpuTrackedWorker } from "../infra/worker-cpu.js";
export { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
// Released official plugins retain these exports until their supported hosts
// provide worker-task-server; bundled workers use that narrower entrypoint.
export { serveWorkerTasks } from "../infra/worker-task-server.js";
export type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
export type { WorkerTaskResponse } from "../infra/worker-task-pool.js";
export { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
export { reapOrphanedProcesses } from "../process/orphaned-process.js";
export {
  spawnTerminalPty,
  type TerminalPtyHandle,
  type TerminalPtySpawnParams,
  type TerminalPtySubscription,
} from "../process/terminal-pty.js";
export {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
export { prepareSecretInputStdio, type SpawnStdioEntry } from "../process/spawn-secret-input.js";

export {
  createOwnedStdioProcess,
  closeOwnedStdioProcess,
  type OwnedStdioProcess,
  type OwnedStdioProcessOptions,
} from "../process/owned-stdio.js";

export {
  DarwinProcessInspectionError,
  readDarwinProcessSnapshot,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
  type DarwinProcess,
} from "../process/darwin-process-inspection.js";

export { hasErrnoCode } from "../infra/errno.js";
export { resolveExecutablePath } from "../infra/executable-path.js";
export { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
export { withGitProcessOperation } from "../process/spawn-diagnostics.js";

export { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
export { getShellConfig } from "../agents/shell-utils.js";

export {
  executeGitCommand,
  gitNullConfigPath,
  requireGitCommandOutput,
  type GitCommandOptions,
} from "../infra/git-exec.js";

export { withGitNetworkRetry, type GitOperationStarter } from "../infra/git-network-retry.js";
export { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";

export { withGitRepositoryRepair } from "../infra/git-repository-repair.js";

export {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
} from "../process/exec-result.js";

export { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export { ProjectCloneError } from "../projects/project-clone-contract.js";

export {
  configureProjectCheckoutMaintenance,
  PROJECT_MAINTENANCE_CONFIG,
  projectCheckoutGitEnvironment,
  runProjectGitCommand,
} from "../projects/project-checkout-maintenance.js";
