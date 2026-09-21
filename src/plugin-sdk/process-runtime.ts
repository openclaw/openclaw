// Public process helpers for plugins that spawn or probe local commands.

export { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
export { resolveNodeRuntimeExecutable } from "../infra/node-runtime-executable.js";
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
export { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
export type { OomScoreAdjustedSpawn, OomWrapOptions } from "../process/linux-oom-score.js";
export { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
export { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
// Released official plugins retain these exports until their supported hosts
// provide worker-task-server; bundled workers use that narrower entrypoint.
export { serveWorkerTasks } from "../infra/worker-task-server.js";
export type { WorkerTaskControl } from "../infra/worker-task-native-sections.js";
export { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
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
