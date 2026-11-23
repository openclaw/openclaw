import { formatCliCommand } from "../cli/command-format.js";
import { NODE_SERVICE_KIND } from "../daemon/constants.js";
import { resolveNodeService } from "../daemon/node-service.js";
import {
  gatewayServiceCommandMatchesRoot,
  resolveServiceEntrypointIndex,
} from "../daemon/service-layout.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";

/** Advisory only: manual updates never take over the node's idle/restart owner. */
export async function describeNodeUpdateRestart(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  activation: "installed" | "prepared";
}): Promise<string | undefined> {
  try {
    const service = resolveNodeService();
    const options = { timeoutMs: 5_000, requireEffective: true };
    const command = await service.readCommand(params.env, options);
    if (!command) {
      return undefined;
    }
    const kind = command.environment?.OPENCLAW_SERVICE_KIND?.trim();
    const entry = resolveServiceEntrypointIndex(command.programArguments);
    const legacyNode =
      !kind &&
      entry !== undefined &&
      command.programArguments[entry + 1] === "node" &&
      command.programArguments[entry + 2] === "run";
    if (
      (kind !== NODE_SERVICE_KIND && !legacyNode) ||
      (await gatewayServiceCommandMatchesRoot(params.root, command)) !== true
    ) {
      return undefined;
    }
    const runtime = await service.readRuntime(params.env, {
      ...options,
      commandInspection: { kind: "present", command },
    });
    if (runtime.status !== "running") {
      return undefined;
    }
    const pid = runtime.pid ? ` (PID ${runtime.pid})` : "";
    const restart = "`" + formatCliCommand("openclaw node restart", params.env) + "`";
    const status = "`" + formatCliCommand("openclaw update status", params.env) + "`";
    const guidance =
      params.activation === "prepared"
        ? `If the release trial is pending, a node restart alone will not activate it; a local Gateway must activate it first. Check ${status} before restarting the node.`
        : `When the node is idle, run ${restart} to load the updated package.`;
    return `Node service is still running${pid}; this update did not restart it. ${guidance}`;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // Optional reporting needs positive service/install evidence. Unavailable native
    // inspection must not fail a completed update or invent a running node.
    return undefined;
  }
}
