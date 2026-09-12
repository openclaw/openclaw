// Windows Task Scheduler bridge: retain the Job Object owner until the Gateway exits.
import { randomInt } from "node:crypto";
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import {
  formatWindowsTaskSupervisorChildArgument,
  isWindowsTaskSupervisorChildArgument,
  WINDOWS_TASK_LAUNCHER_ACTIVE,
  WINDOWS_TASK_LAUNCHER_ENV,
  WINDOWS_TASK_SUPERVISOR_FLAG,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN,
} from "../../daemon/windows-task-supervisor-contract.js";
import { flushLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getProcessSupervisor, type ManagedRun } from "../../process/supervisor/index.js";

const log = createSubsystemLogger("gateway/task-supervisor");
const STDERR_TAIL_CHARS = 8192;

function renderGatewayTaskCommand(restartExitCode: number): string {
  const childArgs = [...process.execArgv, ...process.argv.slice(1)].filter(
    (argument) =>
      argument !== WINDOWS_TASK_SUPERVISOR_FLAG && !isWindowsTaskSupervisorChildArgument(argument),
  );
  if (childArgs.length === 0) {
    throw new Error("Windows task supervisor could not resolve the Gateway command");
  }
  return [process.execPath, ...childArgs, formatWindowsTaskSupervisorChildArgument(restartExitCode)]
    .map((argument) => quoteCmdScriptArg(argument))
    .join(" ");
}

/**
 * Runs the real Gateway inside the Windows Job Object owned by ProcessSupervisor.
 * The hidden task launcher owns an outer Job containing this supervisor. The
 * command anchor owns the inner Job used for cancellation and extinction joins.
 */
export async function runWindowsGatewayTaskSupervisor(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("--task-supervisor is only available to the Windows Gateway service");
  }
  let stderr = "";
  let managed: ManagedRun | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    managed?.cancel("signal");
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const launcher = process.env[WINDOWS_TASK_LAUNCHER_ENV];
    delete process.env[WINDOWS_TASK_LAUNCHER_ENV];
    if (launcher === WINDOWS_TASK_LAUNCHER_ACTIVE) {
      const [{ default: koffi }, { bindWindowsTaskLauncher }] = await Promise.all([
        import("koffi"),
        import("../../process/supervisor/service-child-windows-task-launcher.js"),
      ]);
      bindWindowsTaskLauncher(koffi);
    }
    while (true) {
      stderr = "";
      // A fresh high-entropy outcome correlates this child-to-supervisor handoff.
      // Common dependency exit codes must terminate the task instead of respawning forever.
      const restartExitCode = randomInt(
        WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN,
        WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX + 1,
      );
      managed = await getProcessSupervisor().spawn({
        mode: "anchored-shell",
        command: renderGatewayTaskCommand(restartExitCode),
        scopeKey: `gateway-task-supervisor:${process.pid}`,
        captureOutput: false,
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
        },
      });
      if (cancelled) {
        managed.cancel("signal");
      }
      const result = await managed.wait();
      // Persist the child outcome before joining cleanup, which can fail independently.
      const diagnostic = {
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        reason: result.reason,
        stderr,
      };
      const restarting = !cancelled && result.exitCode === restartExitCode;
      if (result.exitCode === 0) {
        log.info("Gateway child exited", diagnostic);
      } else if (restarting) {
        log.info("Gateway child requested restart", diagnostic);
      } else {
        process.exitCode = result.exitCode ?? 1;
        log.error("Gateway child failed", diagnostic);
      }
      await managed.waitForExtinction?.();
      managed = null;
      if (restarting && !cancelled) {
        // The child has released its Gateway lock and extinguished descendants.
        // Recheck cancellation after the asynchronous extinction join so shutdown
        // cannot admit a replacement; stop and update handoffs exit 0.
        continue;
      }
      return;
    }
  } catch (error) {
    process.exitCode = 1;
    log.error(`Gateway task supervisor failed: ${String(error)}`, { stderr });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await flushLogger();
  }
}
