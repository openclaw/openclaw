/**
 * Execution Kernel for the Agent Execution Layer.
 *
 * The unified entry point for all agent execution. Composes RuntimeResolver,
 * TurnExecutor, StateService, and EventRouter into a single orchestration layer.
 *
 * Invariants:
 * - Exactly one lifecycle.start per execution
 * - Exactly one lifecycle.end OR lifecycle.error per execution
 * - No exceptions escape - all errors captured in ExecutionResult
 *
 * @see docs/design/plans/opus/01-agent-execution-layer.md
 */

import type { TurnExecutor } from "./executor.js";
import type { RuntimeResolver } from "./resolver.js";
import type { StateService, StatePersistOptions } from "./state.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionEvent,
  ExecutionError,
  ExecutionErrorKind,
  TurnOutcome,
  RuntimeContext,
  UsageMetrics,
} from "./types.js";
import {
  createEventRouter,
  createLifecycleStartEvent,
  createLifecycleEndEvent,
  createLifecycleErrorEvent,
} from "./events.js";
import { createTurnExecutor } from "./executor.js";
import { createRuntimeResolver } from "./resolver.js";
import { createStateService } from "./state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * ExecutionKernel interface - the unified entry point for agent execution.
 */
export interface ExecutionKernel {
  /**
   * Execute a single agent turn.
   *
   * Orchestration flow:
   * 1. Validate request
   * 2. Generate runId
   * 3. Emit lifecycle.start
   * 4. Resolve runtime context
   * 5. Execute turn
   * 6. Persist state
   * 7. Emit lifecycle.end/error
   * 8. Build and return result
   *
   * @param request - The execution request
   * @returns Execution result (never throws)
   */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;

  /**
   * Abort an active execution.
   *
   * @param runId - The run ID to abort
   */
  abort(runId: string): Promise<void>;

  /**
   * Get the count of currently active runs.
   */
  getActiveRunCount(): number;
}

/**
 * Logger interface for ExecutionKernel.
 */
export type ExecutionKernelLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Options for creating an ExecutionKernel.
 */
export interface ExecutionKernelOptions {
  /** RuntimeResolver instance. */
  resolver: RuntimeResolver;
  /** TurnExecutor instance. */
  executor: TurnExecutor;
  /** StateService instance. */
  stateService: StateService;
  /** Optional logger for debug output. */
  logger?: ExecutionKernelLogger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Active run tracking for abort support.
 */
interface ActiveRun {
  runId: string;
  abortController: AbortController;
  startTime: number;
}

/**
 * Default ExecutionKernel implementation.
 *
 * Orchestrates the full execution flow:
 * 1. Validate request
 * 2. Generate runId
 * 3. Emit lifecycle.start
 * 4. Resolve runtime context
 * 5. Execute turn
 * 6. Persist state
 * 7. Emit lifecycle.end/error
 * 8. Build and return result
 */
export class DefaultExecutionKernel implements ExecutionKernel {
  private resolver: RuntimeResolver;
  private executor: TurnExecutor;
  private stateService: StateService;
  private logger?: ExecutionKernelLogger;
  private activeRuns = new Map<string, ActiveRun>();

  constructor(options: ExecutionKernelOptions) {
    this.resolver = options.resolver;
    this.executor = options.executor;
    this.stateService = options.stateService;
    this.logger = options.logger;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Generate runId if not provided
    const runId = request.runId ?? crypto.randomUUID();
    const startTime = Date.now();

    // Create event router for this run
    const emitter = createEventRouter({
      logger: this.logger,
    });

    // Wire up request's onEvent callback if provided
    if (request.onEvent) {
      emitter.subscribe(request.onEvent);
    }

    // Create abort controller for this run
    const abortController = new AbortController();

    // Track active run
    this.activeRuns.set(runId, { runId, abortController, startTime });

    // Track whether we've emitted lifecycle.end or lifecycle.error (for invariant enforcement)
    let emittedEndOrError = false;

    // Default empty usage metrics
    const emptyUsage: UsageMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };

    try {
      // Step 1: Validate request (before lifecycle.start)
      const validationError = this.validateRequest(request);
      if (validationError) {
        // Emit lifecycle.error for validation failure (no lifecycle.start for invalid requests)
        await emitter.emit(
          createLifecycleErrorEvent(runId, {
            error: validationError.message,
            kind: validationError.kind,
            retryable: validationError.retryable,
          }),
        );
        emittedEndOrError = true;

        return this.buildErrorResult(
          runId,
          validationError,
          emitter.getEmittedEvents(),
          emptyUsage,
          startTime,
        );
      }

      // Step 2: Emit lifecycle.start
      await emitter.emit(
        createLifecycleStartEvent(runId, {
          prompt: request.prompt,
          agentId: request.agentId,
          sessionKey: request.sessionKey,
        }),
      );

      // Step 3: Check if already aborted
      if (abortController.signal.aborted) {
        await emitter.emit(
          createLifecycleErrorEvent(runId, {
            error: "Execution aborted before start",
            kind: "aborted",
            retryable: false,
          }),
        );
        emittedEndOrError = true;
        return this.buildAbortedResult(runId, emitter.getEmittedEvents(), emptyUsage, startTime);
      }

      // Step 4: Resolve runtime context
      let context: RuntimeContext;
      try {
        context = await this.resolver.resolve(request);
      } catch (err) {
        const error = this.buildExecutionError("runtime_unavailable", err);
        await emitter.emit(
          createLifecycleErrorEvent(runId, {
            error: error.message,
            kind: error.kind,
            retryable: error.retryable,
          }),
        );
        emittedEndOrError = true;
        return this.buildErrorResult(
          runId,
          error,
          emitter.getEmittedEvents(),
          emptyUsage,
          startTime,
        );
      }

      this.logger?.debug?.(
        `[ExecutionKernel] resolved runtime: ${context.kind} provider=${context.provider} model=${context.model}`,
      );

      // Step 5: Execute turn
      let outcome: TurnOutcome;
      try {
        // Create a request with the runId set
        const requestWithRunId: ExecutionRequest = { ...request, runId };
        outcome = await this.executor.execute(context, requestWithRunId, emitter);
      } catch (err) {
        const error = this.buildExecutionError("runtime_error", err);
        await emitter.emit(
          createLifecycleErrorEvent(runId, {
            error: error.message,
            kind: error.kind,
            retryable: error.retryable,
          }),
        );
        emittedEndOrError = true;
        return this.buildErrorResult(
          runId,
          error,
          emitter.getEmittedEvents(),
          emptyUsage,
          startTime,
        );
      }

      // Step 6: Check if aborted during execution
      if (abortController.signal.aborted) {
        await emitter.emit(
          createLifecycleErrorEvent(runId, {
            error: "Execution aborted during turn",
            kind: "aborted",
            retryable: false,
          }),
        );
        emittedEndOrError = true;
        return this.buildAbortedResult(
          runId,
          emitter.getEmittedEvents(),
          outcome.usage,
          startTime,
          outcome,
          context,
        );
      }

      // Step 7: Persist state (non-blocking - errors are logged but don't fail execution)
      try {
        const persistOptions: StatePersistOptions = {};
        await this.stateService.persist(request, outcome, context, persistOptions);
      } catch (err) {
        this.logger?.warn?.(
          `[ExecutionKernel] state persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // State persistence failure doesn't fail the execution
      }

      // Step 8: Emit lifecycle.end
      await emitter.emit(
        createLifecycleEndEvent(runId, {
          success: true,
          durationMs: Date.now() - startTime,
        }),
      );
      emittedEndOrError = true;

      // Step 9: Build success result
      return this.buildSuccessResult(
        runId,
        outcome,
        context,
        emitter.getEmittedEvents(),
        startTime,
      );
    } catch (err) {
      // Catch-all for any unexpected errors
      const error = this.buildExecutionError("unknown", err);

      // Emit lifecycle.error only if we haven't already emitted end/error
      if (!emittedEndOrError) {
        emitter.emitSync(
          createLifecycleErrorEvent(runId, {
            error: error.message,
            kind: error.kind,
            retryable: error.retryable,
          }),
        );
      }

      return this.buildErrorResult(runId, error, emitter.getEmittedEvents(), emptyUsage, startTime);
    } finally {
      // Clean up active run tracking
      this.activeRuns.delete(runId);
    }
  }

  async abort(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      this.logger?.debug?.(`[ExecutionKernel] abort: no active run with id ${runId}`);
      return;
    }

    this.logger?.debug?.(`[ExecutionKernel] aborting run ${runId}`);
    activeRun.abortController.abort();
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validateRequest(request: ExecutionRequest): ExecutionError | null {
    // Check required fields
    if (!request.agentId) {
      return {
        kind: "validation_failed",
        message: "Missing required field: agentId",
        retryable: false,
      };
    }

    if (!request.sessionId) {
      return {
        kind: "validation_failed",
        message: "Missing required field: sessionId",
        retryable: false,
      };
    }

    if (!request.workspaceDir) {
      return {
        kind: "validation_failed",
        message: "Missing required field: workspaceDir",
        retryable: false,
      };
    }

    if (request.prompt === undefined || request.prompt === null) {
      return {
        kind: "validation_failed",
        message: "Missing required field: prompt",
        retryable: false,
      };
    }

    // Validate timeout if provided
    if (request.timeoutMs !== undefined && request.timeoutMs <= 0) {
      return {
        kind: "validation_failed",
        message: "timeoutMs must be positive",
        retryable: false,
      };
    }

    // Validate maxTokens if provided
    if (request.maxTokens !== undefined && request.maxTokens <= 0) {
      return {
        kind: "validation_failed",
        message: "maxTokens must be positive",
        retryable: false,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Error Building
  // ---------------------------------------------------------------------------

  private buildExecutionError(kind: ExecutionErrorKind, err: unknown): ExecutionError {
    const message = err instanceof Error ? err.message : String(err);

    // Determine if error is retryable based on kind
    const retryable = kind === "runtime_error" || kind === "quota_exceeded";

    return {
      kind,
      message,
      cause: err,
      retryable,
    };
  }

  // ---------------------------------------------------------------------------
  // Result Building
  // ---------------------------------------------------------------------------

  private buildSuccessResult(
    _runId: string,
    outcome: TurnOutcome,
    context: RuntimeContext,
    events: ExecutionEvent[],
    startTime: number,
  ): ExecutionResult {
    return {
      success: true,
      aborted: false,
      reply: outcome.reply,
      payloads: outcome.payloads,
      runtime: {
        kind: context.kind,
        provider: context.provider,
        model: context.model,
        fallbackUsed: outcome.fallbackUsed,
      },
      usage: {
        ...outcome.usage,
        durationMs: Date.now() - startTime,
      },
      events,
      toolCalls: outcome.toolCalls,
      didSendViaMessagingTool: outcome.didSendViaMessagingTool,
      // Extended metadata
      embeddedError: outcome.embeddedError,
      systemPromptReport: outcome.systemPromptReport,
      messagingToolSentTexts: outcome.messagingToolSentTexts,
      messagingToolSentTargets: outcome.messagingToolSentTargets,
      cliSessionId: outcome.cliSessionId,
      claudeSdkSessionId: outcome.claudeSdkSessionId,
    };
  }

  private buildErrorResult(
    _runId: string,
    error: ExecutionError,
    events: ExecutionEvent[],
    usage: UsageMetrics,
    startTime: number,
  ): ExecutionResult {
    return {
      success: false,
      aborted: false,
      error,
      reply: "",
      payloads: [],
      runtime: {
        kind: "pi",
        fallbackUsed: false,
      },
      usage: {
        ...usage,
        durationMs: Date.now() - startTime,
      },
      events,
      toolCalls: [],
      didSendViaMessagingTool: false,
    };
  }

  private buildAbortedResult(
    _runId: string,
    events: ExecutionEvent[],
    usage: UsageMetrics,
    startTime: number,
    outcome?: TurnOutcome,
    context?: RuntimeContext,
  ): ExecutionResult {
    return {
      success: false,
      aborted: true,
      error: {
        kind: "aborted",
        message: "Execution was aborted",
        retryable: false,
      },
      reply: outcome?.reply ?? "",
      payloads: outcome?.payloads ?? [],
      runtime: {
        kind: context?.kind ?? "pi",
        provider: context?.provider,
        model: context?.model,
        fallbackUsed: outcome?.fallbackUsed ?? false,
      },
      usage: {
        ...usage,
        durationMs: Date.now() - startTime,
      },
      events,
      toolCalls: outcome?.toolCalls ?? [],
      didSendViaMessagingTool: outcome?.didSendViaMessagingTool ?? false,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create an ExecutionKernel instance with provided dependencies.
 *
 * @param options - Kernel options with resolver, executor, and state service
 * @returns ExecutionKernel instance
 */
export function createExecutionKernel(options: ExecutionKernelOptions): ExecutionKernel {
  return new DefaultExecutionKernel(options);
}

/**
 * Create an ExecutionKernel with default dependencies.
 *
 * This factory creates all the necessary services with default configurations.
 * Use this for standard execution scenarios.
 *
 * @param logger - Optional logger for debug output
 * @returns Configured ExecutionKernel instance
 */
export function createDefaultExecutionKernel(logger?: ExecutionKernelLogger): ExecutionKernel {
  return createExecutionKernel({
    resolver: createRuntimeResolver({ logger }),
    executor: createTurnExecutor({ logger }),
    stateService: createStateService({ logger }),
    logger,
  });
}
