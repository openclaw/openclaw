/**
 * Workflow Logic Engine
 *
 * Handles conditional execution (If/Else, Switch, etc.)
 * Supports branching and merging in workflow chains
 */

import { getChildLogger } from "../logging.js";

const logger = getChildLogger({ module: "workflow-logic" });

/**
 * Branch configuration for If/Else nodes
 */
export interface BranchConfig {
  condition: string; // Expression to evaluate
  trueLabel?: string; // Label for true branch
  falseLabel?: string; // Label for false branch
}

/**
 * Workflow chain node with branching support
 */
export interface WorkflowChainNode {
  nodeId: string;
  actionType: string;
  label: string;
  config?: Record<string, unknown>;

  // Branching (for logic nodes)
  branches?: {
    condition?: string;
    trueChain?: WorkflowChainNode[];
    falseChain?: WorkflowChainNode[];
  };

  // Sequential flow
  next?: WorkflowChainNode;
}

/**
 * Execution context passed through chain
 */
export interface ExecutionContext {
  currentInput: string;
  variables: Map<string, string>;
  previousOutputs: Map<string, string>;
  abortSignal?: AbortSignal;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  status: "ok" | "error" | "branched";
  output?: string;
  error?: string;
  branchTaken?: "true" | "false";
}

/**
 * Evaluate a condition expression safely
 * Note: Uses Function constructor with strict validation
 * Only allows safe operations on input string
 */
export function evaluateCondition(params: {
  condition: string;
  context: ExecutionContext;
}): boolean {
  const { condition, context } = params;

  try {
    // Validate condition - only allow safe characters and patterns
    const safeConditionRegex = /^[a-zA-Z0-9_\s.'",!?()><=!&|+\-*.]+$/;
    if (!safeConditionRegex.test(condition)) {
      logger.error({ condition }, "condition contains unsafe characters");
      return false;
    }

    // Check for dangerous patterns
    const dangerousPatterns = [
      /\brequire\b/,
      /\bimport\b/,
      /\bprocess\b/,
      /\bglobal\b/,
      /\beval\b/,
      /\bFunction\b/,
      /\bconstructor\b/,
      /\b__proto__\b/,
      /\bprototype\b/,
      /window\./,
      /document\./,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(condition)) {
        logger.error(
          { condition, pattern: pattern.toString() },
          "condition contains dangerous pattern",
        );
        return false;
      }
    }

    // Create safe evaluation context
    const input = context.currentInput;
    const variables = Object.fromEntries(context.variables);

    // Helper functions for safe evaluation
    const helpers = {
      includes: (str: string, search: string) => str.includes(search),
      startsWith: (str: string, prefix: string) => str.startsWith(prefix),
      endsWith: (str: string, suffix: string) => str.endsWith(suffix),
      length: (str: string) => str.length,
      upper: (str: string) => str.toUpperCase(),
      lower: (str: string) => str.toLowerCase(),
      eq: (a: unknown, b: unknown) => a === b,
      gt: (a: number, b: number) => a > b,
      lt: (a: number, b: number) => a < b,
      gte: (a: number, b: number) => a >= b,
      lte: (a: number, b: number) => a <= b,
    };

    // Create function with isolated scope
    // eslint-disable-next-line no-implied-eval
    const evalFn = new Function(
      "input",
      "variables",
      "helpers",
      `
      "use strict";
      try {
        return Boolean(${condition});
      } catch (e) {
        return false;
      }
    `,
    );

    const result = evalFn(input, variables, helpers);
    return Boolean(result);
  } catch (error) {
    logger.error(
      {
        condition,
        error: error instanceof Error ? error.message : String(error),
      },
      "condition evaluation failed",
    );
    return false;
  }
}

/**
 * Execute a branch based on condition
 */
export async function executeBranch(
  branchConfig: BranchConfig,
  trueChain: WorkflowChainNode[],
  falseChain: WorkflowChainNode[] | undefined,
  context: ExecutionContext,
  executeChainFn: (
    chain: WorkflowChainNode[],
    context: ExecutionContext,
  ) => Promise<ExecutionResult>,
): Promise<ExecutionResult> {
  logger.info(
    {
      condition: branchConfig.condition,
      trueLabel: branchConfig.trueLabel,
      falseLabel: branchConfig.falseLabel,
    },
    "evaluating branch condition",
  );

  // Evaluate condition
  const conditionResult = evaluateCondition({
    condition: branchConfig.condition,
    context,
  });

  logger.info(
    {
      condition: branchConfig.condition,
      result: conditionResult,
    },
    "branch condition evaluated",
  );

  // Select and execute appropriate branch
  const chainToExecute = conditionResult ? trueChain : falseChain || [];
  const branchTaken = conditionResult ? "true" : "false";

  if (chainToExecute.length === 0) {
    logger.info({ branchTaken }, "empty branch, skipping");
    return {
      status: "branched",
      branchTaken,
      output: context.currentInput,
    };
  }

  const result = await executeChainFn(chainToExecute, context);

  return {
    ...result,
    branchTaken,
  };
}

/**
 * Build execution tree from flat chain with branching metadata
 */
export function buildExecutionTree(
  nodes: Array<{
    nodeId: string;
    actionType: string;
    label: string;
    config?: Record<string, unknown>;
    branchId?: string;
    parentLogicNodeId?: string;
    condition?: string;
  }>,
  edges: Array<{ source: string; target: string }>,
): WorkflowChainNode[] {
  const nodeMap = new Map<string, WorkflowChainNode>();

  // First pass: create all nodes
  for (const nodeData of nodes) {
    nodeMap.set(nodeData.nodeId, {
      nodeId: nodeData.nodeId,
      actionType: nodeData.actionType,
      label: nodeData.label,
      config: nodeData.config,
    });
  }

  // Second pass: build connections
  const roots: WorkflowChainNode[] = [];
  const hasIncomingEdge = new Set<string>();

  for (const edge of edges) {
    hasIncomingEdge.add(edge.target);

    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);

    if (!sourceNode || !targetNode) {
      continue;
    }

    // Check if source is a logic node with branching
    if (sourceNode.actionType === "if-else" && sourceNode.branches) {
      // This would need additional metadata to determine true/false edge
      // For now, add to next (simplified)
      sourceNode.next = targetNode;
    } else {
      sourceNode.next = targetNode;
    }
  }

  // Find root nodes (no incoming edges)
  for (const [nodeId, node] of nodeMap.entries()) {
    if (!hasIncomingEdge.has(nodeId)) {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Check if a node is a logic/branching node
 */
export function isLogicNode(actionType: string): boolean {
  return ["if-else", "switch", "branch"].includes(actionType);
}

/**
 * Validate branching structure
 */
export function validateBranching(nodes: WorkflowChainNode[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  function validateNode(node: WorkflowChainNode, visited: Set<string>): void {
    if (visited.has(node.nodeId)) {
      errors.push(`Cycle detected at node: ${node.nodeId}`);
      return;
    }

    visited.add(node.nodeId);

    // Validate If/Else nodes
    if (node.actionType === "if-else") {
      if (!node.branches?.condition) {
        errors.push(`If/Else node ${node.nodeId} missing condition`);
      }
      if (!node.branches?.trueChain || node.branches.trueChain.length === 0) {
        errors.push(`If/Else node ${node.nodeId} missing true branch`);
      }
    }

    // Validate next
    if (node.next) {
      validateNode(node.next, new Set(visited));
    }

    // Validate branches
    if (node.branches?.trueChain) {
      for (const child of node.branches.trueChain) {
        validateNode(child, new Set(visited));
      }
    }
    if (node.branches?.falseChain) {
      for (const child of node.branches.falseChain) {
        validateNode(child, new Set(visited));
      }
    }
  }

  for (const root of nodes) {
    validateNode(root, new Set());
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
