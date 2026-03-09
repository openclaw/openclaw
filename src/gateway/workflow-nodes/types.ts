/**
 * Workflow Nodes - Type Definitions
 *
 * Standardized interfaces for workflow node execution
 */

/**
 * Execution status returned by node handlers
 */
export type NodeExecutionStatus = "success" | "error" | "branched";

/**
 * Branch taken by If/Else node
 */
export type BranchDirection = "true" | "false";

/**
 * Output from a node execution
 */
export interface NodeOutput {
  /** Execution status */
  status: NodeExecutionStatus;

  /** Output text passed to next node in chain */
  output?: string;

  /** Error message if status is "error" */
  error?: string;

  /** Branch taken (for If/Else nodes only) */
  branchTaken?: BranchDirection;

  /** Additional metadata for logging/debugging */
  metadata?: Record<string, unknown>;
}

/**
 * Input to a node handler
 */
export interface NodeInput {
  /** Unique node ID from workflow */
  nodeId: string;

  /** Human-readable node label */
  label: string;

  /** Action type (e.g., "agent-prompt", "if-else") */
  actionType: string;

  /** Output from previous node in chain */
  previousOutput?: string;

  /** Node-specific configuration */
  config: NodeConfig;

  /** Workflow-level variables */
  variables: Map<string, string>;

  /** Gateway dependencies */
  deps: WorkflowDeps;
}

/**
 * Node configuration - varies by node type
 */
export interface NodeConfig {
  // Common
  [key: string]: unknown;

  // Agent Prompt
  agentId?: string;
  prompt?: string;

  // Send Message
  body?: string;
  channel?: string;
  recipientId?: string;
  accountId?: string;

  // If/Else
  condition?: string;
  trueChain?: WorkflowChainStep[];
  falseChain?: WorkflowChainStep[];

  // Execute Tool
  toolName?: string;
  toolArgs?: Record<string, unknown>;

  // Remote Invoke
  nodeId?: string;
  command?: string;
  params?: Record<string, unknown>;

  // TTS
  text?: string;
  voiceId?: string;
  provider?: string;

  // Delay
  durationMs?: number;

  // Custom JS
  code?: string;
}

/**
 * Workflow chain step (from UI serialization)
 */
export interface WorkflowChainStep {
  nodeId: string;
  actionType: string;
  label: string;
  agentId?: string;
  prompt?: string;
  body?: string;
  channel?: string;
  recipientId?: string;
  accountId?: string;
  condition?: string;
  trueChain?: WorkflowChainStep[];
  falseChain?: WorkflowChainStep[];
  config?: NodeConfig;
}

/**
 * Gateway dependencies for workflow execution
 */
export interface WorkflowDeps {
  /** CLI dependencies */
  cliDeps: import("../../cli/deps.js").CliDeps;

  /** Config */
  cfg: import("../../config/config.js").OpenClawConfig;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Execution context passed through chain
 */
export interface ExecutionContext {
  /** Current input (output from previous node) */
  currentInput: string;

  /** Workflow variables */
  variables: Map<string, string>;

  /** Previous outputs map (nodeId -> output) */
  previousOutputs: Map<string, string>;

  /** Abort signal */
  abortSignal?: AbortSignal;
}

/**
 * Workflow node handler interface
 */
export interface WorkflowNodeHandler {
  /** Action type this handler processes */
  actionType: string;

  /**
   * Execute the node
   * @param input - Node input with config and context
   * @param context - Execution context
   * @returns Execution result
   */
  execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput>;
}

/**
 * Helper function to render template variables
 * Replaces {{input}} and {{variables.name}} with actual values
 */
export function renderTemplate(
  template: string,
  input: string,
  variables: Map<string, string>,
): string {
  return template
    .replace(/\{\{input\}\}/g, input)
    .replace(/\{\{variables\.(\w+)\}\}/g, (_, key) => variables.get(key) || "");
}

/**
 * Helper function to evaluate condition expressions safely
 */
export function evaluateCondition(
  condition: string,
  input: string,
  variables: Map<string, string>,
): boolean {
  try {
    // Validate condition - only allow safe characters
    const safeConditionRegex = /^[a-zA-Z0-9_\s.'",!?()><=!&|+\-*.]+$/;
    if (!safeConditionRegex.test(condition)) {
      console.error("[Workflow] Condition contains unsafe characters:", condition);
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
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(condition)) {
        console.error("[Workflow] Condition contains dangerous pattern:", pattern);
        return false;
      }
    }

    // Create safe evaluation context
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

    const vars = Object.fromEntries(variables);

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

    const result = evalFn(input, vars, helpers);
    return Boolean(result);
  } catch (error) {
    console.error(
      "[Workflow] Condition evaluation failed:",
      condition,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
