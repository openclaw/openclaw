// Process-local node state shared by node and full-device pairing removal.
import { removeRemoteNodeInfo } from "../../skills/runtime/remote.js";
import { clearNodePendingWork } from "../node-pending-work.js";
import { invalidateNodeWakeState } from "./nodes-wake-state.js";
import type { GatewayRequestContext } from "./shared-types.js";

export type PendingNodeAction = {
  id: string;
  nodeId: string;
  pairingGeneration: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
  enqueuedAtMs: number;
};

export const pendingNodeActionsById = new Map<string, PendingNodeAction[]>();

export function clearRemovedNodeRuntimeState(params: {
  nodeId: string;
  context: Pick<GatewayRequestContext, "nodeRegistry">;
}) {
  pendingNodeActionsById.delete(params.nodeId);
  clearNodePendingWork(params.nodeId);
  invalidateNodeWakeState(params.nodeId);
  params.context.nodeRegistry.updateSurface(params.nodeId, {
    caps: [],
    commands: [],
    permissions: undefined,
  });
  removeRemoteNodeInfo(params.nodeId);
}
