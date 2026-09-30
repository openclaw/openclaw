import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { createPlacementSessionToolOperationKernel } from "./placement-session-tool-operations.kernel.js";
import type { PlacementSessionToolReceipt } from "./placement-session-tool-operations.receipt.js";

type Kernel = ReturnType<typeof createPlacementSessionToolOperationKernel>;
export type PlacementSessionToolWorkerOperations = {
  [Method in keyof Kernel as `placementTools.${Method}`]: {
    input: { args: Parameters<Kernel[Method]>; instanceId: string; nowMs?: number };
    output: PlacementSessionToolReceipt;
  };
};
export function isPlacementSessionToolCommand(command: {
  type: PropertyKey;
}): command is SqliteWorkerCommand<PlacementSessionToolWorkerOperations> {
  return typeof command.type === "string" && command.type.startsWith("placementTools.");
}
