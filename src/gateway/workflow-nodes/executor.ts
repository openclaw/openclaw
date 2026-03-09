/**
 * Workflow Chain Executor
 *
 * Executes a workflow chain with support for branching
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getNodeHandler } from "./registry.js";
import type { WorkflowChainStep, NodeOutput, ExecutionContext, WorkflowDeps } from "./types.js";

const logger = createSubsystemLogger("workflow-executor");

/**
 * Execute a single node in the chain
 */
async function executeNode(
  step: WorkflowChainStep,
  context: ExecutionContext,
  deps: WorkflowDeps,
): Promise<NodeOutput> {
  const handler = getNodeHandler(step.actionType);

  if (!handler) {
    logger.warn("workflow: unknown node handler, skipping", {
      nodeId: step.nodeId,
      actionType: step.actionType,
      label: step.label,
    });

    return {
      status: "error",
      error: `Unknown action type: ${step.actionType}`,
      metadata: {
        nodeId: step.nodeId,
        label: step.label,
        actionType: step.actionType,
        unknownHandler: true,
      },
    };
  }

  const input = {
    nodeId: step.nodeId,
    label: step.label,
    actionType: step.actionType,
    previousOutput: context.currentInput,
    config: step.config || {
      agentId: step.agentId,
      prompt: step.prompt,
      body: step.body,
      channel: step.channel,
      recipientId: step.recipientId,
      accountId: step.accountId,
      condition: step.condition,
      trueChain: step.trueChain,
      falseChain: step.falseChain,
    },
    variables: context.variables,
    deps,
  };

  logger.info("workflow: executing node", {
    nodeId: step.nodeId,
    actionType: step.actionType,
    label: step.label,
  });

  const result = await handler.execute(input, context);

  logger.info("workflow: node execution complete", {
    nodeId: step.nodeId,
    actionType: step.actionType,
    label: step.label,
    status: result.status,
    branchTaken: result.branchTaken,
    outputLength: result.output?.length,
  });

  return result;
}

/**
 * Execute a chain of workflow nodes with branching support
 */
export async function executeWorkflowChain(
  chain: WorkflowChainStep[],
  initialInput: string,
  deps: WorkflowDeps,
): Promise<NodeOutput> {
  const context: ExecutionContext = {
    currentInput: initialInput,
    variables: new Map<string, string>(),
    previousOutputs: new Map<string, string>(),
    abortSignal: deps.abortSignal,
  };

  let lastResult: NodeOutput | undefined;

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];

    logger.info("workflow: executing chain step", {
      step: i + 1,
      total: chain.length,
      nodeId: step.nodeId,
      actionType: step.actionType,
      label: step.label,
    });

    // Execute the node
    const result = await executeNode(step, context, deps);

    // Store output for reference
    if (result.output) {
      context.previousOutputs.set(step.nodeId, result.output);
    }

    // Handle errors
    if (result.status === "error") {
      logger.error("workflow: chain execution failed", {
        step: i + 1,
        nodeId: step.nodeId,
        error: result.error,
      });

      return result;
    }

    // Handle branching (If/Else)
    if (result.status === "branched" && result.branchTaken) {
      logger.info("workflow: branch taken, executing branch chain", {
        step: i + 1,
        nodeId: step.nodeId,
        branchTaken: result.branchTaken,
      });

      // Get the appropriate branch chain
      const branchChain = result.branchTaken === "true" ? step.trueChain : step.falseChain;

      if (branchChain && branchChain.length > 0) {
        // Execute the branch chain recursively
        const branchResult = await executeWorkflowChain(branchChain, context.currentInput, deps);

        // Update context with branch result
        context.currentInput = branchResult.output || context.currentInput;
        lastResult = branchResult;

        // If branch failed, stop execution
        if (branchResult.status === "error") {
          return branchResult;
        }
      } else {
        // Empty branch - just continue
        logger.info("workflow: empty branch, continuing", {
          step: i + 1,
          nodeId: step.nodeId,
          branchTaken: result.branchTaken,
        });
        lastResult = result;
      }
    } else {
      // Normal execution - update context
      if (result.output) {
        context.currentInput = result.output;
      }
      lastResult = result;
    }
  }

  logger.info("workflow: chain execution complete", {
    totalSteps: chain.length,
    finalStatus: lastResult?.status,
    finalOutputLength: lastResult?.output?.length,
  });

  return (
    lastResult || {
      status: "success",
      output: initialInput,
    }
  );
}
