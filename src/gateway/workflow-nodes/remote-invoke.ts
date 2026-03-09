/**
 * Remote Invoke Node Handler
 *
 * Invokes a command on a paired node device
 *
 * TODO: Implement node.invoke integration
 * For now, this is a placeholder that returns an error
 */

import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";

export const remoteInvokeHandler: WorkflowNodeHandler = {
  actionType: "remote-invoke",

  async execute(input: NodeInput, _context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const targetNodeId = config.nodeId;
      const command = config.command;
      const params = config.params;

      if (!targetNodeId) {
        return {
          status: "error",
          error: "Remote Invoke node missing nodeId configuration",
          metadata: {
            nodeId,
            label,
          },
        };
      }

      if (!command) {
        return {
          status: "error",
          error: "Remote Invoke node missing command configuration",
          metadata: {
            nodeId,
            label,
          },
        };
      }

      // TODO: Implement actual node invocation
      // This will integrate with the node.invoke gateway method
      return {
        status: "error",
        error: `Remote invoke not yet implemented: ${command} on node ${targetNodeId}`,
        metadata: {
          nodeId,
          label,
          targetNodeId,
          command,
          params,
          notImplemented: true,
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
