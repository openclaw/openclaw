/**
 * Workflow Nodes - Type Definitions
 *
 * Simplified interfaces for recursive chain execution
 */

/**
 * Execution status returned by node handlers
 */
export type NodeExecutionStatus = "success" | "error";

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
  /** Agent ID for agent-prompt nodes */
  agentId?: string;
  /** Prompt template for agent-prompt nodes */
  prompt?: string;
  /** Message body for send-message nodes */
  body?: string;
  /** Channel for send-message nodes */
  channel?: string;
  /** Recipient ID for send-message nodes */
  recipientId?: string;
  /** Account ID for send-message nodes */
  accountId?: string;
  /** Condition expression (deprecated - not used in recursive model) */
  condition?: string;
  /** Next steps in chain (recursive execution) */
  trueChain?: WorkflowChainStep[];
  /** Deprecated - kept for backward compatibility only */
  falseChain?: WorkflowChainStep[];
  /** Delay duration in ms */
  durationMs?: number;
  /** Custom JS code */
  code?: string;
  /** Tool name for execute-tool */
  toolName?: string;
  /** Tool arguments */
  toolArgs?: Record<string, unknown>;
  /** TTS text */
  text?: string;
  /** TTS voice ID */
  voiceId?: string;
  /** TTS provider */
  provider?: string;
  /** Remote invoke node ID */
  nodeId?: string;
  /** Remote invoke command */
  command?: string;
  /** Remote invoke parameters */
  params?: Record<string, unknown>;
}

/**
 * Workflow chain step (from UI serialization)
 *
 * Each step can have a trueChain for recursive execution.
 * The trueChain is ALWAYS executed after the current step completes.
 */
export interface WorkflowChainStep {
  /** Unique step identifier */
  nodeId: string;
  /** Type of action to execute */
  actionType: string;
  /** Human-readable label */
  label: string;
  /** Agent ID for agent-prompt nodes */
  agentId?: string;
  /** Prompt template for agent-prompt nodes */
  prompt?: string;
  /** Message body for send-message nodes */
  body?: string;
  /** Channel for send-message nodes */
  channel?: string;
  /** Recipient ID for send-message nodes */
  recipientId?: string;
  /** Account ID for send-message nodes */
  accountId?: string;
  /** Condition expression (deprecated - not used in recursive model) */
  condition?: string;
  /** Next steps in chain (recursive execution) */
  trueChain?: WorkflowChainStep[];
  /** Deprecated - kept for backward compatibility only */
  falseChain?: WorkflowChainStep[];
  /** Delivery configuration */
  delivery?: import("../../cron/types.js").CronDelivery;
  /** Session configuration */
  sessionConfig?: import("../../infra/cron/workflow-executor.js").SessionConfig;
  /** Node-specific configuration */
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
