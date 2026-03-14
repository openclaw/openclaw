import crypto from "node:crypto";
import type { OpenClawConfig, SupabaseWorkflowStep } from "../../config/types.js";
import type { CliDeps } from "../../cli/deps.js";
import { logInfo, logWarn, logDebug, logError } from "../../logger.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent/run.js";
import { resolveCronAgentSessionKey } from "../../cron/isolated-agent/session-key.js";
import {
  createSupabaseClient,
  supabaseSelect,
  supabaseInsert,
  supabaseUpdate,
  supabaseDelete,
  supabaseRpc,
  type SupabaseResult,
} from "../supabase/client.js";

/**
 * Session configuration for workflow steps.
 * Controls token optimization through isolated sessions and minimal context.
 */
export interface SessionConfig {
  /**
   * Session target strategy:
   * - 'isolated': Fresh session for this step (max token savings)
   * - 'reuse': Reuse existing session from workflow
   * - 'main': Use main session (full context, higher token cost)
   */
  target: "isolated" | "reuse" | "main";
  /**
   * Context mode for prompt building:
   * - 'minimal': Only current step input (90-96% token savings)
   * - 'full': Full workflow context
   * - 'custom': Custom context template
   */
  contextMode: "minimal" | "full" | "custom";
  /** Optional model override for this step */
  model?: string;
  /** Optional max tokens limit */
  maxTokens?: number;
  /** Thinking level: 'on' | 'off' */
  thinking?: "on" | "off";
}

/**
 * Workflow chain step definition.
 * Each step can have its own session configuration for token optimization.
 */
export interface WorkflowChainStep {
  /** Unique step identifier */
  nodeId: string;
  /** Type of action to execute */
  actionType: string;
  /** Human-readable label */
  label: string;
  /** Optional agent ID to use */
  agentId?: string;
  /** Prompt template or message */
  prompt?: string;
  /** Expected output schema for validation */
  outputSchema?: Record<string, unknown>;
  /** Session configuration for token optimization */
  sessionConfig?: SessionConfig;
}

/**
 * Execution context passed through workflow steps.
 */
export interface WorkflowExecutionContext {
  /** Workflow ID */
  workflowId: string;
  /** Timestamp when workflow started */
  timestamp: number;
  /** Current step index */
  currentStepIndex: number;
  /** Results from previous steps */
  stepResults: Record<string, unknown>;
  /** Shared context data */
  sharedData: Record<string, unknown>;
  /** Session tracking */
  sessions: Map<string, string>;
}

/**
 * Token tracking for workflow execution.
 */
export interface TokenTracking {
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total tokens */
  totalTokens: number;
  /** Cache read tokens */
  cacheReadTokens: number;
  /** Cache write tokens */
  cacheWriteTokens: number;
  /** Per-step breakdown */
  stepBreakdown: Record<string, {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
}

/**
 * Result of executing a workflow step.
 */
export interface StepExecutionResult {
  /** Step ID */
  nodeId: string;
  /** Success status */
  success: boolean;
  /** Output from step execution */
  output?: unknown;
  /** Error message if failed */
  error?: string;
  /** Session ID used */
  sessionId?: string;
  /** Session key used */
  sessionKey?: string;
  /** Token usage for this step */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Execution duration in ms */
  durationMs: number;
}

/**
 * Result of executing a complete workflow.
 */
export interface WorkflowExecutionResult {
  /** Workflow ID */
  workflowId: string;
  /** Success status */
  success: boolean;
  /** Results from all steps */
  stepResults: StepExecutionResult[];
  /** Final output */
  finalOutput?: unknown;
  /** Total token usage */
  tokenTracking?: TokenTracking;
  /** Error message if failed */
  error?: string;
  /** Total execution duration in ms */
  totalDurationMs: number;
}

/**
 * Workflow Executor with isolated sessions for token optimization.
 * 
 * Key features:
 * - Isolated sessions per step (90-96% token savings)
 * - Session reuse within workflow
 * - Minimal context prompts
 * - Token tracking and logging
 */
export class WorkflowExecutor {
  private config: OpenClawConfig;
  private deps: CliDeps;
  private tokenTracking: TokenTracking;
  private activeSessions: Map<string, { sessionId: string; sessionKey: string; createdAt: number }>;

  constructor(config: OpenClawConfig, deps: CliDeps) {
    this.config = config;
    this.deps = deps;
    this.tokenTracking = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      stepBreakdown: {},
    };
    this.activeSessions = new Map();
  }

  /**
   * Execute a complete workflow chain.
   */
  async executeWorkflow(
    workflowId: string,
    steps: WorkflowChainStep[],
    initialContext?: Partial<WorkflowExecutionContext>,
  ): Promise<WorkflowExecutionResult> {
    const timestamp = Date.now();
    const startTime = Date.now();
    
    const context: WorkflowExecutionContext = {
      workflowId,
      timestamp,
      currentStepIndex: 0,
      stepResults: {},
      sharedData: initialContext?.sharedData ?? {},
      sessions: new Map(),
    };

    const stepResults: StepExecutionResult[] = [];
    let workflowSuccess = true;
    let workflowError: string | undefined;

    logInfo(`[workflow:${workflowId}] Starting workflow execution with ${steps.length} steps`);

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        context.currentStepIndex = i;

        logDebug(`[workflow:${workflowId}] Executing step ${i + 1}/${steps.length}: ${step.nodeId}`);

        const result = await this.executeStep(step, context);
        stepResults.push(result);

        if (!result.success) {
          workflowSuccess = false;
          workflowError = result.error;
          logWarn(`[workflow:${workflowId}] Step ${step.nodeId} failed: ${result.error}`);
          break;
        }

        // Store result in context for next steps
        context.stepResults[step.nodeId] = result.output;
      }

      // Get final output from last successful step
      const finalOutput = stepResults.length > 0 
        ? stepResults[stepResults.length - 1].output 
        : undefined;

      const totalDurationMs = Date.now() - startTime;

      logInfo(
        `[workflow:${workflowId}] Workflow completed in ${totalDurationMs}ms. ` +
        `Success: ${workflowSuccess}, Steps: ${stepResults.length}, ` +
        `Total tokens: ${this.tokenTracking.totalTokens}`
      );

      return {
        workflowId,
        success: workflowSuccess,
        stepResults,
        finalOutput,
        tokenTracking: this.tokenTracking,
        error: workflowError,
        totalDurationMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logWarn(`[workflow:${workflowId}] Workflow execution failed: ${errorMessage}`);
      
      return {
        workflowId,
        success: false,
        stepResults,
        tokenTracking: this.tokenTracking,
        error: errorMessage,
        totalDurationMs: Date.now() - startTime,
      };
    } finally {
      // Cleanup active sessions
      await this.cleanupSessions(workflowId);
    }
  }

  /**
   * Execute a single workflow step.
   */
  async executeStep(
    step: WorkflowChainStep,
    context: WorkflowExecutionContext,
  ): Promise<StepExecutionResult> {
    const startTime = Date.now();
    
    try {
      // Handle Supabase operations
      if (step.actionType.startsWith('supabase-')) {
        return await this.executeSupabaseStep(step, context);
      }

      // Handle agent prompt operations
      const sessionConfig = step.sessionConfig ?? { target: "isolated", contextMode: "minimal" };
      
      // Determine session strategy
      const sessionInfo = await this.getOrCreateSession(
        context.workflowId,
        context.timestamp,
        step.nodeId,
        sessionConfig,
        context,
      );

      // Build prompt based on context mode
      const prompt = this.buildPrompt(step, context, sessionConfig);

      // Execute the step
      const result = await this.executeAgentPrompt(step, prompt, sessionInfo, context);

      const durationMs = Date.now() - startTime;

      // Track token usage
      if (result.tokenUsage) {
        this.trackTokenUsage(step.nodeId, result.tokenUsage);
      }

      return {
        nodeId: step.nodeId,
        success: true,
        output: result.output,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        tokenUsage: result.tokenUsage,
        durationMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      logWarn(`[workflow:${context.workflowId}] Step ${step.nodeId} failed: ${errorMessage}`);

      return {
        nodeId: step.nodeId,
        success: false,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Execute agent prompt with isolated session.
   */
  async executeAgentPrompt(
    step: WorkflowChainStep,
    prompt: string,
    sessionInfo: { sessionId: string; sessionKey: string },
    context: WorkflowExecutionContext,
  ): Promise<{
    output?: unknown;
    sessionId: string;
    sessionKey: string;
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  }> {
    const sessionConfig = step.sessionConfig ?? { target: "isolated", contextMode: "minimal" };
    const agentId = step.agentId;

    logDebug(`[workflow:${context.workflowId}] Executing agent prompt for step ${step.nodeId}`);

    // Create a temporary job object for the isolated agent runner
    const tempJob = {
      id: `${context.workflowId}:${step.nodeId}`,
      name: step.label,
      agentId,
      sessionTarget: sessionConfig.target as "main" | "isolated",
      sessionKey: sessionInfo.sessionKey,
      payload: {
        kind: "agentTurn" as const,
        message: prompt,
        model: sessionConfig.model,
        thinking: sessionConfig.thinking === "on" ? "enabled" : undefined,
      },
      delivery: {
        mode: "none" as const,
      },
    };

    try {
      const result = await runCronIsolatedAgentTurn({
        cfg: this.config,
        deps: this.deps,
        job: tempJob as any,
        message: prompt,
        sessionKey: sessionInfo.sessionKey,
        agentId,
      });

      return {
        output: result.outputText ?? result.summary,
        sessionId: result.sessionId ?? sessionInfo.sessionId,
        sessionKey: result.sessionKey ?? sessionInfo.sessionKey,
        tokenUsage: result.usage ? {
          inputTokens: result.usage.input_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          totalTokens: result.usage.total_tokens ?? 0,
        } : undefined,
      };
    } catch (error) {
      logWarn(`[workflow:${context.workflowId}] Agent execution failed for step ${step.nodeId}: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a Supabase workflow step.
   */
  private async executeSupabaseStep(
    step: WorkflowChainStep,
    context: WorkflowExecutionContext,
  ): Promise<StepExecutionResult> {
    const startTime = Date.now();
    const stepConfig = step as unknown as SupabaseWorkflowStep;
    
    try {
      // Get Supabase instance config
      const supabaseConfig = this.config.supabase;
      if (!supabaseConfig) {
        throw new Error("Supabase configuration not found in OpenClaw config");
      }

      const instanceName = stepConfig.instance ?? supabaseConfig.defaultInstance ?? Object.keys(supabaseConfig.instances)[0];
      const instanceConfig = supabaseConfig.instances[instanceName];
      
      if (!instanceConfig) {
        throw new Error(`Supabase instance '${instanceName}' not found in configuration`);
      }

      // Create Supabase client
      const client = createSupabaseClient({
        url: instanceConfig.url,
        key: typeof instanceConfig.key === 'string' ? instanceConfig.key : instanceConfig.key.id,
        schema: instanceConfig.schema,
      });

      let result: SupabaseResult;

      // Execute based on action type
      switch (step.actionType) {
        case 'supabase-select':
          result = await this.executeSupabaseSelect(client, stepConfig);
          break;
        case 'supabase-insert':
          result = await this.executeSupabaseInsert(client, stepConfig);
          break;
        case 'supabase-update':
          result = await this.executeSupabaseUpdate(client, stepConfig);
          break;
        case 'supabase-delete':
          result = await this.executeSupabaseDelete(client, stepConfig);
          break;
        case 'supabase-rpc':
          result = await this.executeSupabaseRpc(client, stepConfig);
          break;
        default:
          throw new Error(`Unknown Supabase action type: ${step.actionType}`);
      }

      const durationMs = Date.now() - startTime;

      if (!result.success) {
        logWarn(`[workflow:${context.workflowId}] Supabase step ${step.nodeId} failed: ${result.error}`);
        return {
          nodeId: step.nodeId,
          success: false,
          error: result.error ?? 'Unknown error',
          durationMs,
        };
      }

      logInfo(`[workflow:${context.workflowId}] Supabase step ${step.nodeId} completed successfully`);
      return {
        nodeId: step.nodeId,
        success: true,
        output: result,
        durationMs,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      logError(`[workflow:${context.workflowId}] Supabase step ${step.nodeId} failed: ${errorMessage}`);
      return {
        nodeId: step.nodeId,
        success: false,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Execute Supabase SELECT operation.
   */
  private async executeSupabaseSelect(
    client: any,
    config: SupabaseWorkflowStep,
  ): Promise<SupabaseResult> {
    if (!config.table) {
      throw new Error("Table name is required for SELECT operation");
    }

    return await supabaseSelect(client, {
      table: config.table,
      columns: config.columns,
      filters: config.filters,
      orderBy: config.orderBy,
      limit: config.limit,
    });
  }

  /**
   * Execute Supabase INSERT operation.
   */
  private async executeSupabaseInsert(
    client: any,
    config: SupabaseWorkflowStep,
  ): Promise<SupabaseResult> {
    if (!config.table) {
      throw new Error("Table name is required for INSERT operation");
    }
    if (!config.data) {
      throw new Error("Data is required for INSERT operation");
    }

    return await supabaseInsert(client, {
      table: config.table,
      data: config.data,
    });
  }

  /**
   * Execute Supabase UPDATE operation.
   */
  private async executeSupabaseUpdate(
    client: any,
    config: SupabaseWorkflowStep,
  ): Promise<SupabaseResult> {
    if (!config.table) {
      throw new Error("Table name is required for UPDATE operation");
    }
    if (!config.data) {
      throw new Error("Data is required for UPDATE operation");
    }
    if (!config.filters) {
      throw new Error("Filters are required for UPDATE operation");
    }

    return await supabaseUpdate(client, {
      table: config.table,
      data: config.data,
      filters: config.filters,
    });
  }

  /**
   * Execute Supabase DELETE operation.
   */
  private async executeSupabaseDelete(
    client: any,
    config: SupabaseWorkflowStep,
  ): Promise<SupabaseResult> {
    if (!config.table) {
      throw new Error("Table name is required for DELETE operation");
    }
    if (!config.filters) {
      throw new Error("Filters are required for DELETE operation");
    }

    return await supabaseDelete(client, {
      table: config.table,
      filters: config.filters,
    });
  }

  /**
   * Execute Supabase RPC operation.
   */
  private async executeSupabaseRpc(
    client: any,
    config: SupabaseWorkflowStep,
  ): Promise<SupabaseResult> {
    if (!config.functionName) {
      throw new Error("Function name is required for RPC operation");
    }

    return await supabaseRpc(client, {
      function: config.functionName,
      params: config.args,
    });
  }

  /**
   * Create or get isolated session for a step.
   */
  async createIsolatedSession(
    workflowId: string,
    timestamp: number,
    nodeId: string,
    config: SessionConfig,
  ): Promise<{ sessionId: string; sessionKey: string }> {
    const sessionKey = `workflow:${workflowId}:${timestamp}:${nodeId}`;
    const sessionId = crypto.randomUUID();

    // Store session info for reuse tracking
    this.activeSessions.set(sessionKey, {
      sessionId,
      sessionKey,
      createdAt: Date.now(),
    });

    logDebug(`[workflow:${workflowId}] Created isolated session for ${nodeId}: ${sessionKey}`);

    return { sessionId, sessionKey };
  }

  /**
   * Build minimal prompt for a step.
   */
  buildPrompt(
    step: WorkflowChainStep,
    context: WorkflowExecutionContext,
    sessionConfig: SessionConfig,
  ): string {
    const basePrompt = step.prompt ?? "";

    if (sessionConfig.contextMode === "minimal") {
      // Minimal context: only current step input
      const previousOutput = context.currentStepIndex > 0
        ? context.stepResults[Object.keys(context.stepResults)[context.currentStepIndex - 1]]
        : undefined;

      const minimalContext = [
        `Workflow: ${context.workflowId}`,
        `Step: ${step.label} (${step.nodeId})`,
        `Position: ${context.currentStepIndex + 1}`,
        previousOutput ? `\nPrevious step output: ${JSON.stringify(previousOutput)}` : "",
        `\nTask: ${basePrompt}`,
      ].filter(Boolean).join("\n");

      return minimalContext;
    } else if (sessionConfig.contextMode === "full") {
      // Full context: all previous steps
      const fullContext = [
        `Workflow: ${context.workflowId}`,
        `Step: ${step.label} (${step.nodeId})`,
        `\nPrevious steps:`,
        ...Object.entries(context.stepResults).map(([nodeId, output]) => 
          `  - ${nodeId}: ${JSON.stringify(output)}`
        ),
        `\nCurrent task: ${basePrompt}`,
      ].join("\n");

      return fullContext;
    } else {
      // Custom context mode
      return basePrompt;
    }
  }

  /**
   * Get or create session based on config.
   */
  private async getOrCreateSession(
    workflowId: string,
    timestamp: number,
    nodeId: string,
    config: SessionConfig,
    context: WorkflowExecutionContext,
  ): Promise<{ sessionId: string; sessionKey: string }> {
    if (config.target === "main") {
      // Use main session
      const sessionKey = `workflow:${workflowId}:main`;
      return { sessionId: "main", sessionKey };
    }

    if (config.target === "reuse") {
      // Try to reuse existing session from workflow
      const existingSessionKey = Array.from(context.sessions.entries())
        .find(([key]) => key.startsWith(`workflow:${workflowId}`))?.[1];
      
      if (existingSessionKey) {
        const session = this.activeSessions.get(existingSessionKey);
        if (session) {
          logDebug(`[workflow:${workflowId}] Reusing session: ${existingSessionKey}`);
          return { sessionId: session.sessionId, sessionKey: existingSessionKey };
        }
      }
    }

    // Create new isolated session
    const sessionInfo = await this.createIsolatedSession(workflowId, timestamp, nodeId, config);
    context.sessions.set(nodeId, sessionInfo.sessionKey);
    return sessionInfo;
  }

  /**
   * Track token usage for a step.
   */
  private trackTokenUsage(
    nodeId: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    this.tokenTracking.inputTokens += usage.inputTokens;
    this.tokenTracking.outputTokens += usage.outputTokens;
    this.tokenTracking.totalTokens += usage.totalTokens;

    this.tokenTracking.stepBreakdown[nodeId] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };

    logDebug(
      `[workflow:tokens] Step ${nodeId}: ` +
      `input=${usage.inputTokens}, output=${usage.outputTokens}, total=${usage.totalTokens}`
    );
  }

  /**
   * Cleanup sessions after workflow completion.
   */
  private async cleanupSessions(workflowId: string): Promise<void> {
    const sessionsToCleanup = Array.from(this.activeSessions.entries())
      .filter(([key]) => key.startsWith(`workflow:${workflowId}`));

    for (const [sessionKey, sessionInfo] of sessionsToCleanup) {
      logDebug(`[workflow:${workflowId}] Cleaning up session: ${sessionKey}`);
      this.activeSessions.delete(sessionKey);
    }

    logInfo(`[workflow:${workflowId}] Cleaned up ${sessionsToCleanup.length} sessions`);
  }

  /**
   * Get current token tracking summary.
   */
  getTokenTracking(): TokenTracking {
    return { ...this.tokenTracking };
  }

  /**
   * Reset token tracking.
   */
  resetTokenTracking(): void {
    this.tokenTracking = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      stepBreakdown: {},
    };
  }
}
