/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */

import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAfterLlmCallEvent,
  PluginHookAfterLlmCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeCompactionEvent,
  PluginHookBeforeLlmCallEvent,
  PluginHookBeforeLlmCallResult,
  PluginHookBeforeResponseEmitEvent,
  PluginHookBeforeResponseEmitResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookContextAssembledEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookLoopIterationEndEvent,
  PluginHookLoopIterationStartEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookName,
  PluginHookRegistration,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
} from "./types.js";

// Re-export types for consumers
export type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookAfterCompactionEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookSessionContext,
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  // Extended security / agent loop observability hooks
  PluginHookBeforeLlmCallEvent,
  PluginHookBeforeLlmCallResult,
  PluginHookAfterLlmCallEvent,
  PluginHookAfterLlmCallResult,
  PluginHookContextAssembledEvent,
  PluginHookLoopIterationStartEvent,
  PluginHookLoopIterationEndEvent,
  PluginHookBeforeResponseEmitEvent,
  PluginHookBeforeResponseEmitResult,
};

export type HookRunnerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type HookRunnerOptions = {
  logger?: HookRunnerLogger;
  /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
};

/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry: PluginRegistry, options: HookRunnerOptions = {}) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;

  /**
   * Run a hook that doesn't return a value (fire-and-forget style).
   * All handlers are executed in parallel for performance.
   */
  async function runVoidHook<K extends PluginHookName>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<void> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);

    const promises = hooks.map(async (hook) => {
      try {
        await (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx);
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    });

    await Promise.all(promises);
  }

  /**
   * Run a hook that can return a modifying result.
   * Handlers are executed sequentially in priority order, and results are merged.
   */
  async function runModifyingHook<K extends PluginHookName, TResult>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
    mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);

    let result: TResult | undefined;

    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>
        )(event, ctx);

        if (handlerResult !== undefined && handlerResult !== null) {
          if (mergeResults && result !== undefined) {
            result = mergeResults(result, handlerResult);
          } else {
            result = handlerResult;
          }
        }
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    return result;
  }

  // =========================================================================
  // Agent Hooks
  // =========================================================================

  /**
   * Run before_agent_start hook.
   * Allows plugins to inject context into the system prompt.
   * Runs sequentially, merging systemPrompt and prependContext from all handlers.
   */
  async function runBeforeAgentStart(
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentStartResult | undefined> {
    return runModifyingHook<"before_agent_start", PluginHookBeforeAgentStartResult>(
      "before_agent_start",
      event,
      ctx,
      (acc, next) => ({
        systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
        prependContext:
          acc?.prependContext && next.prependContext
            ? `${acc.prependContext}\n\n${next.prependContext}`
            : (next.prependContext ?? acc?.prependContext),
      }),
    );
  }

  /**
   * Run agent_end hook.
   * Allows plugins to analyze completed conversations.
   * Runs in parallel (fire-and-forget).
   */
  async function runAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("agent_end", event, ctx);
  }

  /**
   * Run before_compaction hook.
   */
  async function runBeforeCompaction(
    event: PluginHookBeforeCompactionEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("before_compaction", event, ctx);
  }

  /**
   * Run after_compaction hook.
   */
  async function runAfterCompaction(
    event: PluginHookAfterCompactionEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("after_compaction", event, ctx);
  }

  // =========================================================================
  // Message Hooks
  // =========================================================================

  /**
   * Run message_received hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runMessageReceived(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("message_received", event, ctx);
  }

  /**
   * Run message_sending hook.
   * Allows plugins to modify or cancel outgoing messages.
   * Runs sequentially.
   */
  async function runMessageSending(
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageSendingResult | undefined> {
    return runModifyingHook<"message_sending", PluginHookMessageSendingResult>(
      "message_sending",
      event,
      ctx,
      (acc, next) => ({
        content: next.content ?? acc?.content,
        cancel: next.cancel ?? acc?.cancel,
      }),
    );
  }

  /**
   * Run message_sent hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runMessageSent(
    event: PluginHookMessageSentEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("message_sent", event, ctx);
  }

  // =========================================================================
  // Tool Hooks
  // =========================================================================

  /**
   * Run before_tool_call hook.
   * Allows plugins to modify or block tool calls.
   * Runs sequentially.
   */
  async function runBeforeToolCall(
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<PluginHookBeforeToolCallResult | undefined> {
    return runModifyingHook<"before_tool_call", PluginHookBeforeToolCallResult>(
      "before_tool_call",
      event,
      ctx,
      (acc, next) => ({
        params: next.params ?? acc?.params,
        block: next.block ?? acc?.block,
        blockReason: next.blockReason ?? acc?.blockReason,
      }),
    );
  }

  /**
   * Run after_tool_call hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runAfterToolCall(
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    return runVoidHook("after_tool_call", event, ctx);
  }

  /**
   * Run tool_result_persist hook.
   *
   * This hook is intentionally synchronous: it runs in hot paths where session
   * transcripts are appended synchronously.
   *
   * Handlers are executed sequentially in priority order (higher first). Each
   * handler may return `{ message }` to replace the message passed to the next
   * handler.
   */
  function runToolResultPersist(
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ): PluginHookToolResultPersistResult | undefined {
    const hooks = getHooksForName(registry, "tool_result_persist");
    if (hooks.length === 0) {
      return undefined;
    }

    let current = event.message;

    for (const hook of hooks) {
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const out = (hook.handler as any)({ ...event, message: current }, ctx) as
          | PluginHookToolResultPersistResult
          | void
          | Promise<unknown>;

        // Guard against accidental async handlers (this hook is sync-only).
        // oxlint-disable-next-line typescript/no-explicit-any
        if (out && typeof (out as any).then === "function") {
          const msg =
            `[hooks] tool_result_persist handler from ${hook.pluginId} returned a Promise; ` +
            `this hook is synchronous and the result was ignored.`;
          if (catchErrors) {
            logger?.warn?.(msg);
            continue;
          }
          throw new Error(msg);
        }

        const next = (out as PluginHookToolResultPersistResult | undefined)?.message;
        if (next) {
          current = next;
        }
      } catch (err) {
        const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    return { message: current };
  }

  // =========================================================================
  // Session Hooks
  // =========================================================================

  /**
   * Run session_start hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSessionStart(
    event: PluginHookSessionStartEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    return runVoidHook("session_start", event, ctx);
  }

  /**
   * Run session_end hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSessionEnd(
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ): Promise<void> {
    return runVoidHook("session_end", event, ctx);
  }

  // =========================================================================
  // Gateway Hooks
  // =========================================================================

  /**
   * Run gateway_start hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayStart(
    event: PluginHookGatewayStartEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_start", event, ctx);
  }

  /**
   * Run gateway_stop hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayStop(
    event: PluginHookGatewayStopEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_stop", event, ctx);
  }

  // =========================================================================
  // Extended Security / Agent Loop Observability Hooks
  // =========================================================================

  /**
   * Run before_llm_call hook.
   * Fires before every LLM API call within the agent loop.
   * Allows plugins to inspect/modify context, filter tools, or block the call.
   * Runs sequentially, merging results across handlers.
   */
  async function runBeforeLlmCall(
    event: PluginHookBeforeLlmCallEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeLlmCallResult | undefined> {
    return runModifyingHook<"before_llm_call", PluginHookBeforeLlmCallResult>(
      "before_llm_call",
      event,
      ctx,
      (acc, next) => ({
        messages: next.messages ?? acc?.messages,
        systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
        tools: next.tools ?? acc?.tools,
        block: next.block ?? acc?.block,
        blockReason: next.blockReason ?? acc?.blockReason,
      }),
    );
  }

  /**
   * Run after_llm_call hook.
   * Fires after receiving the LLM response but before executing tool calls.
   * Allows plugins to filter/modify tool calls or block execution.
   * Runs sequentially, merging results across handlers.
   */
  async function runAfterLlmCall(
    event: PluginHookAfterLlmCallEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookAfterLlmCallResult | undefined> {
    return runModifyingHook<"after_llm_call", PluginHookAfterLlmCallResult>(
      "after_llm_call",
      event,
      ctx,
      (acc, next) => ({
        toolCalls: next.toolCalls ?? acc?.toolCalls,
        block: next.block ?? acc?.block,
        blockReason: next.blockReason ?? acc?.blockReason,
      }),
    );
  }

  /**
   * Run context_assembled hook.
   * Fires when the full context is assembled, before the first LLM call.
   * Runs in parallel (fire-and-forget).
   */
  async function runContextAssembled(
    event: PluginHookContextAssembledEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("context_assembled", event, ctx);
  }

  /**
   * Run loop_iteration_start hook.
   * Fires at the start of each agent loop iteration.
   * Runs in parallel (fire-and-forget).
   */
  async function runLoopIterationStart(
    event: PluginHookLoopIterationStartEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("loop_iteration_start", event, ctx);
  }

  /**
   * Run loop_iteration_end hook.
   * Fires at the end of each agent loop iteration.
   * Runs in parallel (fire-and-forget).
   */
  async function runLoopIterationEnd(
    event: PluginHookLoopIterationEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("loop_iteration_end", event, ctx);
  }

  /**
   * Run before_response_emit hook.
   * Fires when the agent's final response is ready, before delivery.
   * Allows plugins to modify content or block emission.
   * Runs sequentially, merging results across handlers.
   */
  async function runBeforeResponseEmit(
    event: PluginHookBeforeResponseEmitEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeResponseEmitResult | undefined> {
    return runModifyingHook<"before_response_emit", PluginHookBeforeResponseEmitResult>(
      "before_response_emit",
      event,
      ctx,
      (acc, next) => ({
        content: next.content ?? acc?.content,
        block: next.block ?? acc?.block,
        blockReason: next.blockReason ?? acc?.blockReason,
      }),
    );
  }

  // =========================================================================
  // Utility
  // =========================================================================

  /**
   * Check if any hooks are registered for a given hook name.
   */
  function hasHooks(hookName: PluginHookName): boolean {
    return registry.typedHooks.some((h) => h.hookName === hookName);
  }

  /**
   * Get count of registered hooks for a given hook name.
   */
  function getHookCount(hookName: PluginHookName): number {
    return registry.typedHooks.filter((h) => h.hookName === hookName).length;
  }

  return {
    // Agent hooks
    runBeforeAgentStart,
    runAgentEnd,
    runBeforeCompaction,
    runAfterCompaction,
    // Message hooks
    runMessageReceived,
    runMessageSending,
    runMessageSent,
    // Tool hooks
    runBeforeToolCall,
    runAfterToolCall,
    runToolResultPersist,
    // Session hooks
    runSessionStart,
    runSessionEnd,
    // Gateway hooks
    runGatewayStart,
    runGatewayStop,
    // Extended security / agent loop observability hooks
    runBeforeLlmCall,
    runAfterLlmCall,
    runContextAssembled,
    runLoopIterationStart,
    runLoopIterationEnd,
    runBeforeResponseEmit,
    // Utility
    hasHooks,
    getHookCount,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;
