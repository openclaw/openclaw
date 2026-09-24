import {
  parseNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorReceipt,
} from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import type { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";

export {
  parseNodeWorkerCancelInput,
  parseNodeWorkerEnvironmentStopInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
} from "../worker/node-supervisor-protocol.js";
export type {
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
  NodeWorkerSupervisorReceipt,
} from "../worker/node-supervisor-protocol.js";

export type NodeWorkerSupervisorControl = Pick<
  ReturnType<typeof createNodeWorkerSupervisor>,
  "launch" | "status" | "retainWorkspaces" | "cancel" | "stopEnvironment"
>;

export function projectNodeWorkerSupervisorReceipt(
  receipt: NodeWorkerLaunchReceipt,
): NodeWorkerSupervisorReceipt {
  const identity = {
    launchId: receipt.launchId,
    planHash: receipt.planHash,
    environmentId: receipt.environmentId,
    sessionId: receipt.sessionId,
    ownerEpoch: receipt.ownerEpoch,
    placementGeneration: receipt.placementGeneration,
    runId: receipt.runId,
  };
  const projected =
    receipt.state === "completed"
      ? { ...identity, state: receipt.state, resultJson: receipt.resultJson }
      : receipt.state === "failed" ||
          receipt.state === "interrupted" ||
          receipt.state === "cancelled"
        ? { ...identity, state: receipt.state, errorText: receipt.errorText }
        : { ...identity, state: receipt.state };
  const parsed = parseNodeWorkerSupervisorReceipt(projected);
  if (!parsed) {
    throw new Error("node worker supervisor durable receipt is inconsistent");
  }
  return parsed;
}
