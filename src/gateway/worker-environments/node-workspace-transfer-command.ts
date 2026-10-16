import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerWorkspaceTransferInput } from "../../worker/node-workspace-transfer-protocol.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";

/** Keep transfer budgets and result validation independent of optional caller guards. */
export function createNodeWorkspaceTransferCommand(
  exec: (command: WorkerWorkspaceCommand) => Promise<NodeWorkerWorkspaceExecResult>,
) {
  return async (
    input: NodeWorkerWorkspaceTransferInput,
    failure: string,
    command: Pick<WorkerWorkspaceCommand, "timeoutMs" | "assertCurrent" | "signal"> = {},
  ) => {
    const result = await exec({
      ...command,
      timeoutMs: command.timeoutMs ?? 10 * 60_000,
      argv: ["openclaw-internal-workspace-transfer"],
      transfer: input,
      transportRetry: "never",
    });
    if (
      result.termination !== "exit" ||
      result.code !== 0 ||
      (input.direction === "download" && result.stdout.trim() !== input.manifestRef)
    ) {
      throw new Error(failure);
    }
    command.assertCurrent?.();
    return result;
  };
}
