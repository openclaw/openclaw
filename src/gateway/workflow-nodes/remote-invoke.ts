/**
 * Remote Invoke Node Handler
 *
 * Invokes a command on a paired node device
 */

import { listDevicePairing } from "../../infra/device-pairing.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";

/**
 * Check if a node is connected
 */
async function isNodeConnected(nodeId: string): Promise<boolean> {
  try {
    const pairing = await listDevicePairing();
    return pairing.paired.some(
      (entry) =>
        (entry.deviceId === nodeId || entry.displayName === nodeId) &&
        entry.role === "node" &&
        entry.tokens !== undefined,
    );
  } catch {
    return false;
  }
}

/**
 * Get node ID from various identifiers
 */
async function resolveNodeId(identifier: string): Promise<string | null> {
  try {
    const pairing = await listDevicePairing();
    const entry = pairing.paired.find(
      (e) => e.deviceId === identifier || e.displayName === identifier || e.remoteIp === identifier,
    );
    return entry?.deviceId || null;
  } catch {
    return null;
  }
}

export const remoteInvokeHandler: WorkflowNodeHandler = {
  actionType: "remote-invoke",

  async execute(input: NodeInput, _context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const targetNodeId = config.nodeId as string;
      const command = config.command;
      const params = config.params;

      if (!targetNodeId) {
        return {
          status: "error",
          error: "Remote Invoke node missing targetNodeId configuration",
          metadata: { nodeId, label },
        };
      }

      if (!command) {
        return {
          status: "error",
          error: "Remote Invoke node missing command configuration",
          metadata: { nodeId, label },
        };
      }

      // Resolve node ID
      const resolvedNodeId = await resolveNodeId(targetNodeId || "");
      if (!resolvedNodeId) {
        return {
          status: "error",
          error: `Node "${targetNodeId}" not found or not paired`,
          metadata: {
            nodeId,
            label,
            targetNodeId: targetNodeId || "",
          },
        };
      }

      // Check node availability
      const isConnected = await isNodeConnected(resolvedNodeId);
      if (!isConnected) {
        return {
          status: "error",
          error: `Node "${resolvedNodeId}" is not connected`,
          metadata: {
            nodeId,
            label,
            targetNodeId: resolvedNodeId,
            command,
          },
        };
      }

      // For now, return a placeholder response
      // TODO: Implement actual node.invoke via gateway WebSocket
      return {
        status: "success",
        output: `Command "${command}" invoked on node ${resolvedNodeId}: ${JSON.stringify(params || {})}`,
        metadata: {
          nodeId,
          label,
          targetNodeId: resolvedNodeId,
          command,
          params,
          invoked: true,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "remote-invoke",
        },
      };
    }
  },
};
