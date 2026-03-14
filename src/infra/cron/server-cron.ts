import type { OpenClawConfig } from "../../config/types.js";
import type { CliDeps } from "../../cli/deps.js";
import { logInfo, logWarn, logDebug } from "../../logger.js";
import type { CronJob, CronJobCreate, CronSchedule, CronDelivery } from "../../cron/types.js";
import { WorkflowExecutor, type WorkflowChainStep, type SessionConfig } from "./workflow-executor.js";

/** Prefix for workflow chain in description */
const WF_CHAIN_PREFIX = "__wf_chain__:";

/**
 * Extended cron job configuration for workflow chains.
 * Allows defining a sequence of steps with individual session configs.
 */
export interface WorkflowCronJob {
  /** Job ID */
  id: string;
  /** Agent ID */
  agentId?: string;
  /** Session key */
  sessionKey?: string;
  /** Job name */
  name: string;
  /** Job description */
  description?: string;
  /** Whether job is enabled */
  enabled: boolean;
  /** Delete after run */
  deleteAfterRun?: boolean;
  /** Workflow-specific schedule */
  schedule: CronSchedule;
  /** Session target */
  sessionTarget: "isolated" | "main";
  /** Wake mode */
  wakeMode: "now" | "next-heartbeat";
  /** Delivery configuration */
  delivery?: CronDelivery;
  /** Workflow type marker */
  workflowType: "chain";
  /** Chain of steps to execute */
  workflowChain: WorkflowChainStep[];
  /** Default session config for all steps (can be overridden per step) */
  defaultSessionConfig?: SessionConfig;
  /** Created timestamp */
  createdAtMs: number;
  /** Updated timestamp */
  updatedAtMs: number;
  /** Optional state */
  state?: Partial<any>;
}

/**
 * Parse workflow chain from cron job description.
 * UI encodes chain as: __wf_chain__:[{...steps...}]
 */
export function parseWorkflowChainFromDescription(
  description: string | undefined,
): WorkflowChainStep[] | null {
  if (!description) {
    return null;
  }

  const prefixIndex = description.indexOf(WF_CHAIN_PREFIX);
  if (prefixIndex === -1) {
    return null;
  }

  try {
    const jsonStart = prefixIndex + WF_CHAIN_PREFIX.length;
    const jsonStr = description.substring(jsonStart).trim();
    
    if (!jsonStr.startsWith("[")) {
      return null;
    }

    const chain = JSON.parse(jsonStr) as WorkflowChainStep[];
    
    if (!Array.isArray(chain)) {
      return null;
    }

    logDebug(`[workflow] Parsed ${chain.length} steps from description`);
    return chain;
  } catch (error) {
    logWarn(`[workflow] Failed to parse workflow chain from description: ${error}`);
    return null;
  }
}

/**
 * Parse session configuration from workflow description.
 * Supports both string shorthand and full SessionConfig objects.
 */
export function parseSessionConfig(
  config: unknown,
  defaultConfig?: SessionConfig,
): SessionConfig {
  const baseConfig: SessionConfig = defaultConfig ?? {
    target: "isolated",
    contextMode: "minimal",
  };

  if (typeof config === "string") {
    // Parse shorthand: "isolated:minimal" or "reuse:full" or "main"
    const parts = config.split(":");
    const target = parts[0] as SessionConfig["target"];
    const contextMode = parts[1] as SessionConfig["contextMode"] | undefined;

    if (["isolated", "reuse", "main"].includes(target)) {
      return {
        ...baseConfig,
        target,
        contextMode: contextMode && ["minimal", "full", "custom"].includes(contextMode)
          ? contextMode
          : baseConfig.contextMode,
      };
    }
  }

  if (typeof config === "object" && config !== null) {
    const obj = config as Partial<SessionConfig>;
    return {
      target: obj.target ?? baseConfig.target,
      contextMode: obj.contextMode ?? baseConfig.contextMode,
      model: obj.model,
      maxTokens: obj.maxTokens,
      thinking: obj.thinking,
    };
  }

  return baseConfig;
}

/**
 * Create workflow cron job from configuration.
 * Automatically encodes workflow chain into description for persistence.
 */
export function createWorkflowCronJob(
  id: string,
  name: string,
  schedule: CronSchedule,
  workflowChain: WorkflowChainStep[],
  options?: {
    delivery?: CronDelivery;
    defaultSessionConfig?: SessionConfig;
    enabled?: boolean;
    description?: string;
    sessionTarget?: "isolated" | "main";
    wakeMode?: "now" | "next-heartbeat";
  },
): WorkflowCronJob {
  // Encode workflow chain into description
  const chainJson = JSON.stringify(workflowChain, null, 2);
  const encodedDescription = options?.description
    ? `${options.description}\n\n${WF_CHAIN_PREFIX}${chainJson}`
    : `${WF_CHAIN_PREFIX}${chainJson}`;

  return {
    id,
    name,
    enabled: options?.enabled ?? true,
    schedule,
    workflowType: "chain" as const,
    workflowChain,
    delivery: options?.delivery ?? { mode: "none" },
    defaultSessionConfig: options?.defaultSessionConfig,
    description: encodedDescription,
    sessionTarget: options?.sessionTarget ?? "isolated",
    wakeMode: options?.wakeMode ?? "now",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  } as WorkflowCronJob;
}

/**
 * Execute a workflow cron job.
 * Handles session lifecycle and token tracking.
 */
export async function executeWorkflowCronJob(
  config: OpenClawConfig,
  deps: CliDeps,
  job: WorkflowCronJob,
  triggerReason?: string,
): Promise<{
  success: boolean;
  workflowId: string;
  stepResults: Array<{ nodeId: string; success: boolean; error?: string }>;
  tokenUsage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  durationMs: number;
  error?: string;
}> {
  const startTime = Date.now();
  const workflowId = `${job.id}:${Date.now()}`;

  logInfo(
    `[workflow-cron:${workflowId}] Starting workflow execution: ${job.name}. ` +
    `Steps: ${job.workflowChain.length}, Trigger: ${triggerReason ?? "scheduled"}`
  );

  try {
    // Initialize workflow executor
    const executor = new WorkflowExecutor(config, deps);

    // Prepare steps with default session config merged
    const steps = job.workflowChain.map((step, index) => ({
      ...step,
      sessionConfig: step.sessionConfig ?? job.defaultSessionConfig ?? {
        target: "isolated",
        contextMode: "minimal",
      },
    }));

    // Execute workflow
    const result = await executor.executeWorkflow(workflowId, steps);

    const durationMs = Date.now() - startTime;

    if (result.success) {
      logInfo(
        `[workflow-cron:${workflowId}] Workflow completed successfully. ` +
        `Duration: ${durationMs}ms, Total tokens: ${result.tokenTracking?.totalTokens ?? 0}`
      );

      return {
        success: true,
        workflowId,
        stepResults: result.stepResults.map((s) => ({
          nodeId: s.nodeId,
          success: s.success,
        })),
        tokenUsage: result.tokenTracking ? {
          totalTokens: result.tokenTracking.totalTokens,
          inputTokens: result.tokenTracking.inputTokens,
          outputTokens: result.tokenTracking.outputTokens,
        } : undefined,
        durationMs,
      };
    } else {
      logWarn(
        `[workflow-cron:${workflowId}] Workflow failed: ${result.error}. ` +
        `Completed steps: ${result.stepResults.filter((s) => s.success).length}/${result.stepResults.length}`
      );

      return {
        success: false,
        workflowId,
        stepResults: result.stepResults.map((s) => ({
          nodeId: s.nodeId,
          success: s.success,
          error: s.error,
        })),
        tokenUsage: result.tokenTracking ? {
          totalTokens: result.tokenTracking.totalTokens,
          inputTokens: result.tokenTracking.inputTokens,
          outputTokens: result.tokenTracking.outputTokens,
        } : undefined,
        durationMs,
        error: result.error,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    logWarn(`[workflow-cron:${workflowId}] Workflow execution error: ${errorMessage}`);

    return {
      success: false,
      workflowId,
      stepResults: [],
      durationMs,
      error: errorMessage,
    };
  }
}

/**
 * Handle session lifecycle for workflow execution.
 * Creates isolated sessions and ensures cleanup.
 */
export async function handleWorkflowSessionLifecycle(
  config: OpenClawConfig,
  deps: CliDeps,
  workflowId: string,
  steps: WorkflowChainStep[],
  sessionConfig?: SessionConfig,
): Promise<{
  success: boolean;
  sessionsCreated: number;
  tokenUsage?: { totalTokens: number };
  error?: string;
}> {
  const executor = new WorkflowExecutor(config, deps);
  const defaultConfig: SessionConfig = sessionConfig ?? {
    target: "isolated",
    contextMode: "minimal",
  };

  try {
    // Prepare steps with session config
    const preparedSteps = steps.map((step) => ({
      ...step,
      sessionConfig: step.sessionConfig ?? defaultConfig,
    }));

    // Execute workflow
    const result = await executor.executeWorkflow(workflowId, preparedSteps);

    if (!result.success) {
      return {
        success: false,
        sessionsCreated: result.stepResults.length,
        tokenUsage: result.tokenTracking ? { totalTokens: result.tokenTracking.totalTokens } : undefined,
        error: result.error,
      };
    }

    return {
      success: true,
      sessionsCreated: result.stepResults.length,
      tokenUsage: result.tokenTracking ? { totalTokens: result.tokenTracking.totalTokens } : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionsCreated: 0,
      error: errorMessage,
    };
  }
}

/**
 * Calculate estimated token savings from using isolated sessions.
 * Based on typical context sizes:
 * - Full context: ~8000-12000 tokens
 * - Minimal context: ~500-1000 tokens
 * - Savings: 90-96%
 */
export function estimateTokenSavings(
  stepCount: number,
  avgFullContextTokens: number = 10000,
  avgMinimalContextTokens: number = 750,
): {
  fullContextTotal: number;
  minimalContextTotal: number;
  tokensSaved: number;
  percentageSaved: number;
} {
  const fullContextTotal = stepCount * avgFullContextTokens;
  const minimalContextTotal = stepCount * avgMinimalContextTokens;
  const tokensSaved = fullContextTotal - minimalContextTotal;
  const percentageSaved = ((tokensSaved / fullContextTotal) * 100).toFixed(2);

  return {
    fullContextTotal,
    minimalContextTotal,
    tokensSaved,
    percentageSaved: parseFloat(percentageSaved),
  };
}

/**
 * Log token tracking summary for a workflow execution.
 */
export function logTokenTrackingSummary(
  workflowId: string,
  tokenTracking: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    stepBreakdown: Record<string, { inputTokens: number; outputTokens: number; totalTokens: number }>;
  },
): void {
  logInfo(`[workflow:${workflowId}] Token Usage Summary:`);
  logInfo(`  Total: ${tokenTracking.totalTokens} (input: ${tokenTracking.inputTokens}, output: ${tokenTracking.outputTokens})`);
  
  const steps = Object.entries(tokenTracking.stepBreakdown);
  if (steps.length > 0) {
    logInfo(`  Per-step breakdown:`);
    steps.forEach(([nodeId, usage]) => {
      logInfo(`    - ${nodeId}: ${usage.totalTokens} tokens`);
    });
  }
}

/**
 * Validate workflow chain configuration.
 */
export function validateWorkflowChain(
  chain: WorkflowChainStep[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!chain || chain.length === 0) {
    errors.push("Workflow chain cannot be empty");
    return { valid: false, errors };
  }

  const nodeIds = new Set<string>();
  chain.forEach((step, index) => {
    if (!step.nodeId || !step.nodeId.trim()) {
      errors.push(`Step ${index}: nodeId is required`);
    }

    if (nodeIds.has(step.nodeId)) {
      errors.push(`Step ${index}: duplicate nodeId '${step.nodeId}'`);
    }
    nodeIds.add(step.nodeId);

    if (!step.actionType || !step.actionType.trim()) {
      errors.push(`Step ${index} (${step.nodeId}): actionType is required`);
    }

    if (!step.label || !step.label.trim()) {
      errors.push(`Step ${index} (${step.nodeId}): label is required`);
    }

    // Validate session config if present
    if (step.sessionConfig) {
      const validTargets = ["isolated", "reuse", "main"];
      const validContextModes = ["minimal", "full", "custom"];

      if (!validTargets.includes(step.sessionConfig.target)) {
        errors.push(`Step ${index} (${step.nodeId}): invalid session target '${step.sessionConfig.target}'`);
      }

      if (!validContextModes.includes(step.sessionConfig.contextMode)) {
        errors.push(`Step ${index} (${step.nodeId}): invalid context mode '${step.sessionConfig.contextMode}'`);
      }

      if (step.sessionConfig.maxTokens !== undefined && step.sessionConfig.maxTokens <= 0) {
        errors.push(`Step ${index} (${step.nodeId}): maxTokens must be positive`);
      }

      if (step.sessionConfig.thinking && !["on", "off"].includes(step.sessionConfig.thinking)) {
        errors.push(`Step ${index} (${step.nodeId}): thinking must be 'on' or 'off'`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}
