/**
 * Turn Executor for the Agent Execution Layer.
 *
 * Executes a single turn and normalizes all output. This layer handles the
 * actual runtime invocation and streaming normalization.
 *
 * Consolidates execution logic previously scattered across:
 * - runAgentTurnWithFallback() in src/auto-reply/reply/agent-runner-execution.ts
 * - runEmbeddedPiAgent() in src/agents/pi-embedded.ts
 * - SDK runtime in src/agents/claude-agent-sdk/sdk-runner.ts
 * - CLI runtime in src/agents/cli-runner.ts
 *
 * @see docs/design/plans/opus/01-agent-execution-layer.md
 */

import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded-runner/types.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { EventRouter } from "./events.js";
import type {
  ExecutionRequest,
  RuntimeContext,
  TurnOutcome,
  ToolCallSummary,
  UsageMetrics,
} from "./types.js";
import { logVerbose } from "../globals.js";
import { createToolStartEvent, createToolEndEvent, createAssistantPartialEvent } from "./events.js";
import {
  normalizeText,
  normalizeStreamingText,
  type NormalizationOptions,
} from "./normalization.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * TurnExecutor interface for executing a single agent turn.
 */
export interface TurnExecutor {
  /**
   * Execute a single turn.
   *
   * @param context - Runtime context from RuntimeResolver
   * @param request - Execution request
   * @param emitter - Event router for emitting execution events
   * @returns Turn outcome with reply, tool calls, and usage metrics
   */
  execute(
    context: RuntimeContext,
    request: ExecutionRequest,
    emitter: EventRouter,
  ): Promise<TurnOutcome>;
}

/**
 * Logger interface for TurnExecutor.
 */
export type TurnExecutorLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Type for the runEmbeddedPiAgent function.
 * Used for dependency injection in tests.
 */
export type RunEmbeddedPiAgentFn = (
  params: RunEmbeddedPiAgentParams,
) => Promise<EmbeddedPiRunResult>;

/**
 * Type for the runCliAgent function.
 * Used for dependency injection in tests.
 */
export type RunCliAgentFn = (params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: import("../config/config.js").OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: import("../auto-reply/thinking.js").ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: import("@mariozechner/pi-ai").ImageContent[];
}) => Promise<EmbeddedPiRunResult>;

/**
 * Options for creating a TurnExecutor.
 */
export interface TurnExecutorOptions {
  /** Optional logger for debug output. */
  logger?: TurnExecutorLogger;
  /** Normalization options for text processing. */
  normalizationOptions?: NormalizationOptions;
  /**
   * Injected Pi runtime function for testing.
   * If not provided, imports runEmbeddedPiAgent at runtime.
   */
  piRuntimeFn?: RunEmbeddedPiAgentFn;
  /**
   * Injected CLI runtime function for testing.
   * If not provided, imports runCliAgent at runtime.
   */
  cliRuntimeFn?: RunCliAgentFn;
}

/**
 * Internal state tracked during turn execution.
 */
interface TurnExecutionState {
  /** Unique run identifier. */
  runId: string;
  /** Start time of execution. */
  startTime: number;
  /** Accumulated partial reply text. */
  partialText: string;
  /** Accumulated block replies. */
  blockReplies: ReplyPayload[];
  /** Tool calls made during the turn. */
  toolCalls: ToolCallSummary[];
  /** Active tool call IDs (started but not ended). */
  activeToolCalls: Map<string, { name: string; startTime: number }>;
  /** Usage metrics. */
  usage: UsageMetrics;
  /** Whether a fallback model was used. */
  fallbackUsed: boolean;
  /** Whether agent sent via messaging tool. */
  didSendViaMessagingTool: boolean;
  /** Whether heartbeat token was stripped. */
  didStripHeartbeat: boolean;
  /** Error that occurred during execution. */
  error?: Error;
}

/**
 * Runtime adapter interface.
 * Abstracts the differences between Pi, Claude SDK, and CLI runtimes.
 */
export interface RuntimeAdapter {
  /**
   * Execute the runtime with the given parameters.
   */
  run(params: RuntimeAdapterParams): Promise<RuntimeAdapterResult>;
}

/**
 * Parameters for runtime adapter execution.
 */
export interface RuntimeAdapterParams {
  prompt: string;
  runId: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  images?: Array<{ type: string; data: string | Uint8Array; mediaType?: string }>;
  onPartialReply?: (payload: ReplyPayload) => void | Promise<void>;
  onBlockReply?: (payload: ReplyPayload) => void | Promise<void>;
  onToolStart?: (
    name: string,
    id: string,
    params?: Record<string, unknown>,
  ) => void | Promise<void>;
  onToolEnd?: (
    name: string,
    id: string,
    success: boolean,
    result?: unknown,
    error?: string,
  ) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
}

/**
 * Result from runtime adapter execution.
 */
export interface RuntimeAdapterResult {
  /** Final reply text. */
  reply: string;
  /** Reply payloads (may include media). */
  payloads: ReplyPayload[];
  /** Whether agent sent via messaging tool. */
  didSendViaMessagingTool: boolean;
  /** Usage metrics from the runtime. */
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Provider session ID (for CLI runtimes). */
  cliSessionId?: string;
  /** Claude SDK session ID (for native resume). */
  claudeSdkSessionId?: string;
  /** Error information if run failed. */
  error?: {
    message: string;
    kind?: string;
  };
  /** System prompt diagnostic report. */
  systemPromptReport?: unknown;
  /** Texts sent via messaging tools during the run. */
  messagingToolSentTexts?: string[];
  /** Messaging tool send targets during the run. */
  messagingToolSentTargets?: unknown[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default TurnExecutor implementation.
 *
 * Handles:
 * - Runtime invocation via adapter
 * - Streaming callback handling
 * - Text normalization
 * - Event emission
 * - Tool call tracking
 * - Usage metric collection
 */
export class DefaultTurnExecutor implements TurnExecutor {
  private logger?: TurnExecutorLogger;
  private normalizationOptions: NormalizationOptions;
  private piRuntimeFn?: RunEmbeddedPiAgentFn;
  private cliRuntimeFn?: RunCliAgentFn;

  constructor(options: TurnExecutorOptions = {}) {
    this.logger = options.logger;
    this.normalizationOptions = options.normalizationOptions ?? {};
    this.piRuntimeFn = options.piRuntimeFn;
    this.cliRuntimeFn = options.cliRuntimeFn;
  }

  async execute(
    context: RuntimeContext,
    request: ExecutionRequest,
    emitter: EventRouter,
  ): Promise<TurnOutcome> {
    const runId = request.runId ?? crypto.randomUUID();
    const state = this.createInitialState(runId);

    // Note: lifecycle events (start/end/error) are managed by the kernel layer.
    // The executor only handles adapter-level events (partial, tool, block).

    try {
      // Create runtime adapter based on context
      const adapter = this.createRuntimeAdapter(context, request);

      // Execute with callbacks wired to state and emitter
      const result = await adapter.run({
        prompt: request.prompt,
        runId,
        abortSignal: undefined, // TODO: Wire abort signal
        timeoutMs: request.timeoutMs,
        images: request.images,
        onPartialReply: (payload) => this.handlePartialReply(state, payload, request, emitter),
        onBlockReply: (payload) => this.handleBlockReply(state, payload, request, emitter),
        onToolStart: (name, id, params) => this.handleToolStart(state, name, id, params, emitter),
        onToolEnd: (name, id, success, result, error) =>
          this.handleToolEnd(state, name, id, success, result, error, emitter),
        onAssistantMessageStart: () => this.handleAssistantMessageStart(state, request, emitter),
      });

      // Update state from result
      state.didSendViaMessagingTool = result.didSendViaMessagingTool;
      this.updateUsageFromResult(state, result);

      // Build final outcome
      return this.buildOutcome(state, result, context);
    } catch (err) {
      state.error = err instanceof Error ? err : new Error(String(err));

      // Re-throw so the kernel can handle lifecycle error emission
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------

  private createInitialState(runId: string): TurnExecutionState {
    return {
      runId,
      startTime: Date.now(),
      partialText: "",
      blockReplies: [],
      toolCalls: [],
      activeToolCalls: new Map(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      },
      fallbackUsed: false,
      didSendViaMessagingTool: false,
      didStripHeartbeat: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime Adapter
  // ---------------------------------------------------------------------------

  /**
   * Create a runtime adapter based on the context.
   * Returns Pi, CLI, or placeholder adapter based on context.kind.
   *
   * Note: Claude SDK runtime is not yet implemented - falls through to placeholder.
   */
  private createRuntimeAdapter(context: RuntimeContext, request: ExecutionRequest): RuntimeAdapter {
    this.logger?.debug?.(`[TurnExecutor] creating adapter for runtime kind: ${context.kind}`);

    switch (context.kind) {
      case "pi":
        return this.createPiRuntimeAdapter(context, request);
      case "cli":
        return this.createCliRuntimeAdapter(context, request);
      case "claude":
        // Claude SDK runtime not yet wired - use placeholder
        this.logger?.warn?.(
          `[TurnExecutor] Claude SDK runtime not yet implemented - using placeholder`,
        );
        return this.createPlaceholderAdapter();
    }
  }

  /**
   * Create a Pi runtime adapter that wraps runEmbeddedPiAgent.
   */
  private createPiRuntimeAdapter(
    context: RuntimeContext,
    request: ExecutionRequest,
  ): RuntimeAdapter {
    return {
      run: async (params: RuntimeAdapterParams): Promise<RuntimeAdapterResult> => {
        // Resolve the Pi runtime function (injected or dynamic import)
        const runPiAgent = this.piRuntimeFn ?? (await this.importPiRuntime());

        const hints = request.runtimeHints;

        // Map RuntimeAdapterParams to RunEmbeddedPiAgentParams
        const piParams: RunEmbeddedPiAgentParams = {
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          sessionFile: request.sessionFile ?? this.resolveSessionFile(request),
          workspaceDir: request.workspaceDir,
          agentDir: request.agentDir,
          config: request.config,
          prompt: params.prompt,
          images: params.images as RunEmbeddedPiAgentParams["images"],
          provider: context.provider,
          model: context.model,
          timeoutMs: params.timeoutMs ?? 120000,
          runId: params.runId,
          abortSignal: params.abortSignal,
          // Wire streaming callbacks
          onPartialReply: params.onPartialReply
            ? (payload) =>
                params.onPartialReply?.({
                  text: payload.text,
                  mediaUrl: undefined,
                  mediaUrls: payload.mediaUrls,
                })
            : undefined,
          onAssistantMessageStart: params.onAssistantMessageStart,
          onBlockReply: params.onBlockReply
            ? (payload) =>
                params.onBlockReply?.({
                  text: payload.text,
                  mediaUrl: undefined,
                  mediaUrls: payload.mediaUrls,
                  replyToId: payload.replyToId,
                  replyToTag: payload.replyToTag,
                  replyToCurrent: payload.replyToCurrent,
                  audioAsVoice: payload.audioAsVoice,
                })
            : undefined,
          // Block streaming config
          onBlockReplyFlush: request.onBlockReplyFlush,
          blockReplyBreak: request.blockReplyBreak,
          blockReplyChunking: request.blockReplyChunking,
          shouldEmitToolResult: request.shouldEmitToolResult,
          shouldEmitToolOutput: request.shouldEmitToolOutput,
          // Reasoning and tool result callbacks
          onReasoningStream: request.onReasoningStream
            ? (payload) =>
                request.onReasoningStream?.({
                  text: payload.text,
                  mediaUrls: payload.mediaUrls,
                })
            : undefined,
          onToolResult: request.onToolResult
            ? (payload) =>
                request.onToolResult?.({
                  text: payload.text,
                  mediaUrls: payload.mediaUrls,
                })
            : undefined,
          onAgentEvent: request.onAgentEvent ? (evt) => request.onAgentEvent?.(evt) : undefined,
          // Message context from request
          messageChannel: request.messageContext?.channel,
          messageProvider: hints?.messageProvider ?? request.messageContext?.provider,
          messageTo: hints?.messageTo,
          messageThreadId: request.messageContext?.threadId,
          groupId: request.messageContext?.groupId,
          groupChannel: request.messageContext?.groupChannel,
          groupSpace: request.messageContext?.groupSpace,
          spawnedBy: request.spawnedBy,
          senderId: request.messageContext?.senderId,
          senderName: request.messageContext?.senderName,
          senderUsername: request.messageContext?.senderUsername,
          senderE164: request.messageContext?.senderE164,
          extraSystemPrompt: request.extraSystemPrompt,
          // Runtime hints (Pi-specific)
          thinkLevel: hints?.thinkLevel,
          verboseLevel: hints?.verboseLevel,
          reasoningLevel: hints?.reasoningLevel,
          authProfileId: hints?.authProfileId,
          authProfileIdSource: hints?.authProfileIdSource,
          enforceFinalTag: hints?.enforceFinalTag,
          ownerNumbers: hints?.ownerNumbers,
          skillsSnapshot: hints?.skillsSnapshot as RunEmbeddedPiAgentParams["skillsSnapshot"],
          execOverrides: hints?.execOverrides as RunEmbeddedPiAgentParams["execOverrides"],
          bashElevated: hints?.bashElevated as RunEmbeddedPiAgentParams["bashElevated"],
          toolResultFormat: hints?.toolResultFormat as RunEmbeddedPiAgentParams["toolResultFormat"],
          // Threading context
          currentChannelId: hints?.currentChannelId,
          currentThreadTs: hints?.currentThreadTs,
          replyToMode: hints?.replyToMode,
          hasRepliedRef: hints?.hasRepliedRef,
        };

        // Execute Pi runtime
        const result = await runPiAgent(piParams);

        // Map EmbeddedPiRunResult to RuntimeAdapterResult
        return this.mapPiResultToAdapterResult(result);
      },
    };
  }

  /**
   * Create a CLI runtime adapter that wraps runCliAgent.
   */
  private createCliRuntimeAdapter(
    context: RuntimeContext,
    request: ExecutionRequest,
  ): RuntimeAdapter {
    return {
      run: async (params: RuntimeAdapterParams): Promise<RuntimeAdapterResult> => {
        // Resolve the CLI runtime function (injected or dynamic import)
        const runCli = this.cliRuntimeFn ?? (await this.importCliRuntime());

        // Map to CLI runtime params
        const cliParams = {
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          sessionFile: this.resolveSessionFile(request),
          workspaceDir: request.workspaceDir,
          config: request.config,
          prompt: params.prompt,
          provider: context.provider,
          model: context.model,
          timeoutMs: params.timeoutMs ?? 120000,
          runId: params.runId,
          extraSystemPrompt: request.extraSystemPrompt,
          images: params.images as import("@mariozechner/pi-ai").ImageContent[] | undefined,
        };

        // Execute CLI runtime
        const result = await runCli(cliParams);

        // Map result (same shape as Pi result)
        return this.mapPiResultToAdapterResult(result);
      },
    };
  }

  /**
   * Create a placeholder adapter for testing or unimplemented runtimes.
   */
  private createPlaceholderAdapter(): RuntimeAdapter {
    return {
      run: async (params: RuntimeAdapterParams): Promise<RuntimeAdapterResult> => {
        this.logger?.warn?.(`[TurnExecutor] using placeholder adapter`);

        // Simulate a simple response
        const reply = `[Placeholder response for: ${params.prompt.slice(0, 50)}...]`;

        return {
          reply,
          payloads: [{ text: reply }],
          didSendViaMessagingTool: false,
          usage: {
            inputTokens: params.prompt.length,
            outputTokens: reply.length,
          },
        };
      },
    };
  }

  /**
   * Dynamically import the Pi runtime to avoid circular dependencies.
   */
  private async importPiRuntime(): Promise<RunEmbeddedPiAgentFn> {
    const { runEmbeddedPiAgent } = await import("../agents/pi-embedded-runner/run.js");
    return runEmbeddedPiAgent;
  }

  /**
   * Dynamically import the CLI runtime to avoid circular dependencies.
   */
  private async importCliRuntime(): Promise<RunCliAgentFn> {
    const { runCliAgent } = await import("../agents/cli-runner.js");
    return runCliAgent;
  }

  /**
   * Map EmbeddedPiRunResult to RuntimeAdapterResult.
   */
  private mapPiResultToAdapterResult(result: EmbeddedPiRunResult): RuntimeAdapterResult {
    // Extract reply text from payloads
    const replyTexts = (result.payloads ?? [])
      .map((p) => p.text)
      .filter((t): t is string => Boolean(t));
    const reply = replyTexts.join("\n\n");

    // Map payloads to ReplyPayload format
    const payloads: ReplyPayload[] = (result.payloads ?? []).map((p) => ({
      text: p.text,
      mediaUrl: p.mediaUrl,
      mediaUrls: p.mediaUrls,
      replyToId: p.replyToId,
      isError: p.isError,
    }));

    // Extract usage from meta
    const usage = result.meta.agentMeta?.usage ?? {};

    return {
      reply,
      payloads: payloads.length > 0 ? payloads : [{ text: reply }],
      didSendViaMessagingTool: result.didSendViaMessagingTool ?? false,
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      },
      claudeSdkSessionId: result.meta.agentMeta?.claudeSessionId,
      error: result.meta.error
        ? { message: result.meta.error.message, kind: result.meta.error.kind }
        : undefined,
      // Extended metadata for auto-reply
      systemPromptReport: result.meta.systemPromptReport,
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentTargets: result.messagingToolSentTargets,
    };
  }

  /**
   * Resolve session file path from request.
   */
  private resolveSessionFile(request: ExecutionRequest): string {
    // Default session file path based on workspace and session
    // This matches the pattern used in existing code
    return `${request.workspaceDir}/.clawdbrain/sessions/${request.sessionId}.jsonl`;
  }

  // ---------------------------------------------------------------------------
  // Callback Handlers
  // ---------------------------------------------------------------------------

  private async handlePartialReply(
    state: TurnExecutionState,
    payload: ReplyPayload,
    request: ExecutionRequest,
    emitter: EventRouter,
  ): Promise<void> {
    const { text, skip } = normalizeStreamingText(payload.text, {
      ...this.normalizationOptions,
      onHeartbeatStrip: () => {
        if (!state.didStripHeartbeat) {
          state.didStripHeartbeat = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
      },
    });

    if (skip || !text) {
      return;
    }

    // Accumulate partial text
    state.partialText += text;

    // Emit partial event
    emitter.emitSync(createAssistantPartialEvent(state.runId, { text }));

    // Invoke request callback with full payload (normalized text)
    if (request.onPartialReply) {
      try {
        await request.onPartialReply({ ...payload, text });
      } catch (err) {
        this.logger?.error?.(
          `[TurnExecutor] onPartialReply callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleBlockReply(
    state: TurnExecutionState,
    payload: ReplyPayload,
    request: ExecutionRequest,
    _emitter: EventRouter,
  ): Promise<void> {
    const { text, skip } = normalizeStreamingText(payload.text, this.normalizationOptions);

    const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

    if (skip && !hasMedia) {
      return;
    }

    // Store normalized block reply
    const normalizedPayload: ReplyPayload = {
      ...payload,
      text: text || undefined,
    };
    state.blockReplies.push(normalizedPayload);

    // Forward to request callback if provided
    if (request.onBlockReply) {
      try {
        await request.onBlockReply(normalizedPayload);
      } catch (err) {
        this.logger?.error?.(
          `[TurnExecutor] onBlockReply callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleToolStart(
    state: TurnExecutionState,
    name: string,
    id: string,
    params: Record<string, unknown> | undefined,
    emitter: EventRouter,
  ): Promise<void> {
    // Track active tool call
    state.activeToolCalls.set(id, {
      name,
      startTime: Date.now(),
    });

    // Emit tool start event
    await emitter.emit(
      createToolStartEvent(state.runId, {
        toolName: name,
        toolCallId: id,
        params,
      }),
    );

    // Invoke request callback if provided
    if (
      typeof (state as unknown as { request?: ExecutionRequest }).request?.onToolStart ===
      "function"
    ) {
      // This would be wired up through the request
    }
  }

  private async handleToolEnd(
    state: TurnExecutionState,
    name: string,
    id: string,
    success: boolean,
    result: unknown,
    error: string | undefined,
    emitter: EventRouter,
  ): Promise<void> {
    // Get start time from active calls
    const activeCall = state.activeToolCalls.get(id);
    const durationMs = activeCall ? Date.now() - activeCall.startTime : undefined;

    // Remove from active calls
    state.activeToolCalls.delete(id);

    // Add to completed tool calls
    const summary: ToolCallSummary = {
      name,
      id,
      success,
      error,
      durationMs,
    };
    state.toolCalls.push(summary);

    // Emit tool end event
    await emitter.emit(
      createToolEndEvent(state.runId, {
        toolName: name,
        toolCallId: id,
        success,
        result,
        error,
        durationMs,
      }),
    );
  }

  private async handleAssistantMessageStart(
    _state: TurnExecutionState,
    request: ExecutionRequest,
    _emitter: EventRouter,
  ): Promise<void> {
    // Forward to request callback if provided (typing indicators)
    if (request.onAssistantMessageStart) {
      try {
        await request.onAssistantMessageStart();
      } catch (err) {
        this.logger?.error?.(
          `[TurnExecutor] onAssistantMessageStart callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Usage Tracking
  // ---------------------------------------------------------------------------

  private updateUsageFromResult(state: TurnExecutionState, result: RuntimeAdapterResult): void {
    state.usage.inputTokens = result.usage.inputTokens ?? 0;
    state.usage.outputTokens = result.usage.outputTokens ?? 0;
    state.usage.cacheReadTokens = result.usage.cacheReadTokens;
    state.usage.cacheWriteTokens = result.usage.cacheWriteTokens;
    state.usage.durationMs = Date.now() - state.startTime;
  }

  // ---------------------------------------------------------------------------
  // Outcome Building
  // ---------------------------------------------------------------------------

  private buildOutcome(
    state: TurnExecutionState,
    result: RuntimeAdapterResult,
    _context: RuntimeContext,
  ): TurnOutcome {
    // Normalize final reply
    const normalized = normalizeText(result.reply, this.normalizationOptions);

    // Build payloads from block replies or result payloads
    const payloads: ReplyPayload[] =
      state.blockReplies.length > 0
        ? state.blockReplies
        : result.payloads
            .map((p) => ({
              ...p,
              text: normalizeText(p.text, this.normalizationOptions).text || undefined,
            }))
            .filter((p) => p.text || p.mediaUrl || (p.mediaUrls?.length ?? 0) > 0);

    return {
      reply: normalized.text,
      payloads,
      toolCalls: state.toolCalls,
      usage: state.usage,
      fallbackUsed: state.fallbackUsed,
      didSendViaMessagingTool: state.didSendViaMessagingTool,
      // Extended metadata
      embeddedError: result.error
        ? { kind: result.error.kind ?? "unknown", message: result.error.message }
        : undefined,
      systemPromptReport: result.systemPromptReport,
      messagingToolSentTexts: result.messagingToolSentTexts,
      messagingToolSentTargets: result.messagingToolSentTargets,
      cliSessionId: result.cliSessionId,
      claudeSdkSessionId: result.claudeSdkSessionId,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a TurnExecutor instance.
 *
 * @param options - Executor options
 * @returns TurnExecutor instance
 */
export function createTurnExecutor(options?: TurnExecutorOptions): TurnExecutor {
  return new DefaultTurnExecutor(options);
}
