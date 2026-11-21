import { ignoreNonCleanupCommandError } from "../process/exec-result.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  readWindowsProcessSnapshot,
} from "./schtasks-process-snapshot.js";
import {
  resolveScheduledTaskCommandPort,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import { WINDOWS_TASK_SUPERVISOR_FLAG } from "./windows-task-supervisor-contract.js";

/**
 * A Startup-folder Gateway runs under its task supervisor, which restarts a terminated child
 * (#194492). Terminate the supervisor root, matched by its exact launcher argv, so the whole
 * fallback tree stops; a Gateway without a matching supervisor is terminated directly.
 */
export async function terminateFallbackRuntime(
  env: GatewayServiceEnv,
  pid: number,
  assertCurrent?: () => void,
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<void> {
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(ignoreNonCleanupCommandError)
      : installedCommand;
  const port = resolveScheduledTaskCommandPort(env, command);
  const snapshot = command?.programArguments.length && port ? readWindowsProcessSnapshot() : null;
  const supervisor =
    snapshot && command
      ? findInstalledProcessPid(
          snapshot,
          port,
          [...command.programArguments, WINDOWS_TASK_SUPERVISOR_FLAG],
          () => true,
        )
      : null;
  await terminateGatewayProcessTree(supervisor ?? pid, assertCurrent);
}
