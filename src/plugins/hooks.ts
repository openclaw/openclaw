/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */

import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentErrorEvent,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeRecallEvent,
  PluginHookBeforeRecallResult,
  PluginHookAfterRecallEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookGatewayContext,
  PluginHookGatewayPreStartEvent,
  PluginHookGatewayPreStopEvent,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageReceivedResult,
  PluginHookRequestPostEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookResponseErrorEvent,
  PluginHookName,
  PluginHookRegistration,
  PluginHookRetryPolicy,
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent,
  PluginHookToolContext,
  PluginHookToolErrorEvent,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
} from "./types.js";

// Re-export types for consumers
export type {
  PluginHookAgentContext,
  PluginHookAgentErrorEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookBeforeRecallEvent,
  PluginHookBeforeRecallResult,
  PluginHookAfterRecallEvent,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookBeforeResetEvent,
  PluginHookAfterCompactionEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookRequestPostEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookResponseErrorEvent,
  PluginHookToolContext,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookAfterToolCallEvent,
  PluginHookToolErrorEvent,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookSessionContext,
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
  PluginHookGatewayContext,
  PluginHookGatewayPreStartEvent,
  PluginHookGatewayPreStopEvent,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
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
  /** Default timeout per async hook handler when timeoutMs is not specified */
  defaultTimeoutMs?: number;
};

export class PluginHookExecutionError extends Error {
  readonly hookName: PluginHookName;
  readonly pluginId: string;
  readonly failClosed: boolean;

  constructor(params: {
    hookName: PluginHookName;
    pluginId: string;
    message: string;
    cause?: unknown;
    failClosed?: boolean;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "PluginHookExecutionError";
    this.hookName = params.hookName;
    this.pluginId = params.pluginId;
    this.failClosed = params.failClosed ?? true;
  }
}

class HookTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`hook timeout after ${timeoutMs}ms`);
    this.name = "HookTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function isHookTimeoutError(error: unknown): error is HookTimeoutError {
  return error instanceof HookTimeoutError;
}

export function isPluginHookExecutionError(error: unknown): error is PluginHookExecutionError {
  return error instanceof PluginHookExecutionError;
}

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
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const concurrencyState = new WeakMap<
    PluginHookRegistration,
    { inFlight: number; waiters: Array<() => void> }
  >();
  const shouldThrowForFailure = (hook: PluginHookRegistration): boolean =>
    !catchErrors || hook.mode === "fail-closed";
  const shouldThrowForTimeout = (hook: PluginHookRegistration): boolean => {
    if (!catchErrors) {
      return true;
    }
    const onTimeout = hook.onTimeout ?? hook.mode ?? "fail-open";
    return onTimeout === "fail-closed";
  };
  const resolveTimeoutMs = (hook: PluginHookRegistration): number =>
    hook.timeoutMs === undefined ? defaultTimeoutMs : hook.timeoutMs;

  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new HookTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const waitForAvailableConcurrency = async (hook: PluginHookRegistration): Promise<void> => {
    const max = hook.maxConcurrency;
    if (!Number.isFinite(max) || max === undefined || max <= 0) {
      return;
    }

    const state = concurrencyState.get(hook) ?? { inFlight: 0, waiters: [] };
    concurrencyState.set(hook, state);

    if (state.inFlight < max) {
      state.inFlight += 1;
      return;
    }

    await new Promise<void>((resolve) => state.waiters.push(resolve));
    state.inFlight += 1;
  };

  const releaseConcurrency = (hook: PluginHookRegistration): void => {
    const max = hook.maxConcurrency;
    if (!Number.isFinite(max) || max === undefined || max <= 0) {
      return;
    }
    const state = concurrencyState.get(hook);
    if (!state) {
      return;
    }
    state.inFlight = Math.max(0, state.inFlight - 1);
    const next = state.waiters.shift();
    if (next) {
      next();
    }
  };

  const runWithConcurrencyLimit = async <T>(
    hook: PluginHookRegistration,
    run: () => Promise<T>,
  ): Promise<T> => {
    await waitForAvailableConcurrency(hook);
    try {
      return await run();
    } finally {
      releaseConcurrency(hook);
    }
  };

  const normalizeRetryPolicy = (
    retry: PluginHookRetryPolicy | undefined,
  ): { count: number; backoffMs: number } => ({
    count: Math.max(0, Math.floor(retry?.count ?? 0)),
    backoffMs: Math.max(0, Math.floor(retry?.backoffMs ?? 0)),
  });

  const executeWithRetry = async <T>(
    hookName: PluginHookName,
    hook: PluginHookRegistration,
    run: () => Promise<T>,
  ): Promise<T> => {
    const { count, backoffMs } = normalizeRetryPolicy(hook.retry);
    const totalAttempts = count + 1;
    let attempt = 0;
    while (true) {
      try {
        return await run();
      } catch (err) {
        attempt += 1;
        if (attempt >= totalAttempts) {
          throw err;
        }
        logger?.warn?.(
          `[hooks] ${hookName} handler from ${hook.pluginId} failed on attempt ${attempt}/${totalAttempts}; retrying`,
        );
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
  };

  const inScope = <K extends PluginHookName>(
    hook: PluginHookRegistration<K>,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): boolean => {
    const scope = hook.scope;
    if (!scope) {
      return true;
    }

    const matches = (allowed: string[] | undefined, value: string | undefined): boolean => {
      if (!allowed) {
        return true;
      }
      if (allowed.length === 0) {
        return false;
      }
      if (!value) {
        return false;
      }
      return allowed.includes(value);
    };

    const channelId =
      typeof (ctx as { channelId?: unknown })?.channelId === "string"
        ? ((ctx as { channelId?: string }).channelId ?? undefined)
        : undefined;
    const agentId =
      typeof (ctx as { agentId?: unknown })?.agentId === "string"
        ? ((ctx as { agentId?: string }).agentId ?? undefined)
        : undefined;
    const toolName =
      (typeof (ctx as { toolName?: unknown })?.toolName === "string"
        ? ((ctx as { toolName?: string }).toolName ?? undefined)
        : undefined) ||
      (typeof (event as { toolName?: unknown })?.toolName === "string"
        ? ((event as { toolName?: string }).toolName ?? undefined)
        : undefined);

    return (
      matches(scope.channels, channelId) &&
      matches(scope.agentIds, agentId) &&
      matches(scope.toolNames, toolName)
    );
  };

  const evaluateCondition = async <K extends PluginHookName>(
    hook: PluginHookRegistration<K>,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<boolean> => {
    if (!hook.condition) {
      return true;
    }
    const shouldRun = await hook.condition(event, ctx);
    return shouldRun;
  };

  const handleHookError = <K extends PluginHookName>(
    hookName: K,
    hook: PluginHookRegistration<K>,
    err: unknown,
  ): never | void => {
    const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
    const shouldThrow = isHookTimeoutError(err)
      ? shouldThrowForTimeout(hook)
      : shouldThrowForFailure(hook);
    if (shouldThrow) {
      throw new PluginHookExecutionError({
        hookName,
        pluginId: hook.pluginId,
        message: msg,
        cause: err,
        failClosed: true,
      });
    }
    logger?.error(msg);
  };

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
        if (!inScope(hook, event, ctx)) {
          return;
        }
        const shouldRun = await evaluateCondition(hook, event, ctx);
        if (!shouldRun) {
          return;
        }
        await runWithConcurrencyLimit(hook, async () =>
          executeWithRetry(hookName, hook, async () =>
            withTimeout(
              Promise.resolve(
                (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx),
              ),
              resolveTimeoutMs(hook),
            ),
          ),
        );
      } catch (err) {
        handleHookError(hookName, hook, err);
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
        if (!inScope(hook, event, ctx)) {
          continue;
        }
        const shouldRun = await evaluateCondition(hook, event, ctx);
        if (!shouldRun) {
          continue;
        }
        const handlerResult = await runWithConcurrencyLimit(hook, async () =>
          executeWithRetry(hookName, hook, async () =>
            withTimeout(
              Promise.resolve(
                (hook.handler as (event: unknown, ctx: unknown) => Promise<TResult>)(event, ctx),
              ),
              resolveTimeoutMs(hook),
            ),
          ),
        );

        if (handlerResult !== undefined && handlerResult !== null) {
          if (mergeResults && result !== undefined) {
            result = mergeResults(result, handlerResult);
          } else {
            result = handlerResult;
          }
        }
      } catch (err) {
        handleHookError(hookName, hook, err);
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
   * Run before_recall hook.
   * Allows plugins to mutate memory recall query parameters before vector search.
   * Runs sequentially and applies last-writer-wins merge semantics.
   */
  async function runBeforeRecall(
    event: PluginHookBeforeRecallEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeRecallResult | undefined> {
    return runModifyingHook<"before_recall", PluginHookBeforeRecallResult>(
      "before_recall",
      event,
      ctx,
      (acc, next) => ({
        query: next.query ?? acc?.query,
        maxResults: next.maxResults ?? acc?.maxResults,
        minScore: next.minScore ?? acc?.minScore,
      }),
    );
  }

  /**
   * Run after_recall hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runAfterRecall(
    event: PluginHookAfterRecallEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("after_recall", event, ctx);
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
   * Run llm_input hook.
   * Allows plugins to observe the exact input payload sent to the LLM.
   * Runs in parallel (fire-and-forget).
   */
  async function runLlmInput(event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) {
    return runVoidHook("llm_input", event, ctx);
  }

  /**
   * Run llm_output hook.
   * Allows plugins to observe the exact output payload returned by the LLM.
   * Runs in parallel (fire-and-forget).
   */
  async function runLlmOutput(event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) {
    return runVoidHook("llm_output", event, ctx);
  }

  /**
   * Run agent_error hook.
   * Allows plugins to handle failed agent runs separately from success completion hooks.
   * Runs in parallel (fire-and-forget).
   */
  async function runAgentError(
    event: PluginHookAgentErrorEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("agent_error", event, ctx);
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

  /**
   * Run before_reset hook.
   * Fired when /new or /reset clears a session, before messages are lost.
   * Runs in parallel (fire-and-forget).
   */
  async function runBeforeReset(
    event: PluginHookBeforeResetEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    return runVoidHook("before_reset", event, ctx);
  }

  // =========================================================================
  // Message Hooks
  // =========================================================================

  /**
   * Run message_received hook.
   * Allows plugins to mutate or cancel inbound request content.
   * Runs sequentially.
   */
  async function runMessageReceived(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageReceivedResult | undefined> {
    return runModifyingHook<"message_received", PluginHookMessageReceivedResult>(
      "message_received",
      event,
      ctx,
      (acc, next) => ({
        content: next.content ?? acc?.content,
        metadata:
          acc?.metadata && next.metadata
            ? { ...acc.metadata, ...next.metadata }
            : (next.metadata ?? acc?.metadata),
        cancel: next.cancel ?? acc?.cancel,
      }),
    );
  }

  /**
   * Run request_post hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runRequestPost(
    event: PluginHookRequestPostEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("request_post", event, ctx);
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

  /**
   * Run response_error hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runResponseError(
    event: PluginHookResponseErrorEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    return runVoidHook("response_error", event, ctx);
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
   * Run tool_error hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runToolError(
    event: PluginHookToolErrorEvent,
    ctx: PluginHookToolContext,
  ): Promise<void> {
    return runVoidHook("tool_error", event, ctx);
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
        if (!inScope(hook, event, ctx)) {
          continue;
        }
        if (hook.condition) {
          const gated = hook.condition({ ...event, message: current } as never, ctx as never);
          if (typeof (gated as Promise<unknown>)?.then === "function") {
            const msg =
              `[hooks] tool_result_persist condition from ${hook.pluginId} returned a Promise; ` +
              "sync hooks require synchronous conditions.";
            if (shouldThrowForFailure(hook)) {
              throw new Error(msg);
            }
            logger?.warn?.(msg);
            continue;
          }
          if (gated === false) {
            continue;
          }
        }

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
          if (!shouldThrowForFailure(hook)) {
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
        handleHookError("tool_result_persist", hook, err);
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
   * Run gateway_pre_start hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayPreStart(
    event: PluginHookGatewayPreStartEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_pre_start", event, ctx);
  }

  /**
   * Run gateway_pre_stop hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runGatewayPreStop(
    event: PluginHookGatewayPreStopEvent,
    ctx: PluginHookGatewayContext,
  ): Promise<void> {
    return runVoidHook("gateway_pre_stop", event, ctx);
  }

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
    runLlmInput,
    runLlmOutput,
    runBeforeRecall,
    runAfterRecall,
    runAgentEnd,
    runAgentError,
    runBeforeCompaction,
    runAfterCompaction,
    runBeforeReset,
    // Message hooks
    runMessageReceived,
    runRequestPost,
    runMessageSending,
    runMessageSent,
    runResponseError,
    // Tool hooks
    runBeforeToolCall,
    runAfterToolCall,
    runToolError,
    runToolResultPersist,
    // Session hooks
    runSessionStart,
    runSessionEnd,
    // Gateway hooks
    runGatewayPreStart,
    runGatewayPreStop,
    runGatewayStart,
    runGatewayStop,
    // Utility
    hasHooks,
    getHookCount,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;
