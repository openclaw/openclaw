/**
 * Workflow Chain Executor
 *
 * Simple, clean recursive execution with trueChain support
 *
 * Architecture:
 * - Each node executes and returns output
 * - If node has trueChain, execute it recursively with the output as input
 * - Chain continues until all steps complete or error occurs
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getNodeHandler } from "./registry.js";
import type {
  WorkflowChainStep,
  NodeOutput,
  ExecutionContext,
  NodeInput,
  WorkflowDeps,
} from "./types.js";

const logger = createSubsystemLogger("workflow-executor");

/**
 * Execute a single node
 *
 * Note: trueChain handling is done by executeNode(), not by individual handlers.
 * Handlers only need to return their output - they don't need to know about chaining.
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

  // Prepare input for handler
  const input: NodeInput = {
    nodeId: step.nodeId,
    label: step.label,
    actionType: step.actionType,
    previousOutput: context.currentInput,
    config: {
      agentId: step.agentId,
      prompt: step.prompt,
      body: step.body,
      channel: step.channel,
      recipientId: step.recipientId,
      accountId: step.accountId,
      trueChain: step.trueChain,
      code: step.config?.code,
      toolName: step.config?.toolName,
      toolArgs: step.config?.toolArgs,
      text: step.config?.text,
      voiceId: step.config?.voiceId,
      provider: step.config?.provider,
      nodeId: step.config?.nodeId,
      command: step.config?.command,
      params: step.config?.params,
    },
    variables: context.variables,
    deps,
  };

  logger.info("workflow: executing node", {
    nodeId: step.nodeId,
    actionType: step.actionType,
    label: step.label,
  });

  // Execute the handler
  const result = await handler.execute(input, context);

  logger.info("workflow: node execution complete", {
    nodeId: step.nodeId,
    actionType: step.actionType,
    label: step.label,
    status: result.status,
    outputLength: result.output?.length,
  });

  // ✅ RECURSIVE: Execute trueChain if exists
  if (step.trueChain && step.trueChain.length > 0) {
    if (result.status === "error") {
      logger.warn("workflow: skipping trueChain due to error", {
        nodeId: step.nodeId,
        error: result.error,
      });
      return result;
    }

    logger.info("workflow: executing trueChain recursively", {
      nodeId: step.nodeId,
      trueChainLength: step.trueChain.length,
    });

    // Execute trueChain with current output as input
    const chainResult = await executeWorkflowChain(
      step.trueChain,
      result.output || context.currentInput,
      deps,
    );

    // Return chain result (not single node result)
    return chainResult;
  }

  return result;
}

/**
 * Execute a chain of workflow nodes
 *
 * This is the main entry point for workflow execution.
 * It processes nodes sequentially and handles trueChain recursion.
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

    // Execute the node (with trueChain recursion handled internally)
    const result = await executeNode(step, context, deps);

    // Store output for reference by next steps
    if (result.output) {
      context.currentInput = result.output;
      context.previousOutputs.set(step.nodeId, result.output);
    }

    // Stop on error
    if (result.status === "error") {
      logger.error("workflow: chain execution failed", {
        step: i + 1,
        nodeId: step.nodeId,
        error: result.error,
      });
      return result;
    }

    lastResult = result;
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
