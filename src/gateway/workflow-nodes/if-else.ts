/**
 * If/Else Node Handler
 *
 * Evaluates a condition and directs flow to true or false branch
 */

import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";
import { evaluateCondition } from "./types.js";
import type { WorkflowChainStep } from "./types.js";

export const ifElseHandler: WorkflowNodeHandler = {
  actionType: "if-else",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      const condition = config.condition as string;

      if (!condition) {
        return {
          status: "error",
          error: "If/Else node missing condition",
          metadata: {
            nodeId,
            label,
          },
        };
      }

      // Evaluate condition
      const result = evaluateCondition(condition, context.currentInput, context.variables);
      const branchTaken = result ? "true" : "false";

      // Get the appropriate chain based on branch
      const selectedChain: WorkflowChainStep[] | undefined = result
        ? config.trueChain
        : config.falseChain;

      // Validate that the selected branch exists
      if (!selectedChain || selectedChain.length === 0) {
        return {
          status: "branched",
          branchTaken,
          output: context.currentInput, // Pass through if no branch
          metadata: {
            nodeId,
            label,
            condition,
            branchTaken,
            branchEmpty: true,
          },
        };
      }

      return {
        status: "branched",
        branchTaken,
        output: context.currentInput, // Pass through - branch selection handled by executor
        metadata: {
          nodeId,
          label,
          condition,
          branchTaken,
          branchSteps: selectedChain.length,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "if-else",
        },
      };
    }
  },
};
