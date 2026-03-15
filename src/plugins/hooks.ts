/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */

import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAfterCompactionEvent,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeCompactionEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookBeforeResetEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
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
  PluginHookSubagentContext,
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentDeliveryTargetResult,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawnedEvent,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "./types.js";

// Re-export types for consumers
export type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookAgentEndEvent,
  PluginHookBeforeCompactionEvent,
  PluginHookBeforeResetEvent,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
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
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
  PluginHookSessionContext,
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
  PluginHookSubagentContext,
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentDeliveryTargetResult,
  PluginHookSubagentSpawningEvent,
  PluginHookSubagentSpawningResult,
  PluginHookSubagentSpawnedEvent,
  PluginHookSubagentEndedEvent,
  PluginHookGatewayContext,
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
};

export type PluginTargetedInboundClaimOutcome =
  | {
      status: "handled";
      result: PluginHookInboundClaimResult;
    }
  | {
      status: "missing_plugin";
    }
  | {
      status: "no_handler";
    }
  | {
      status: "declined";
    }
  | {
      status: "error";
      error: string;
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

function getHooksForNameAndPlugin<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
  pluginId: string,
): PluginHookRegistration<K>[] {
  return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}

/**
 * Deep-merge two messageMeta bags.  Top-level keys are plugin-namespaced
 * (e.g. `"memory-lancedb"`) and each plugin's value is an object whose
 * array-valued keys are concatenated so multiple hook phases can each
 * contribute entries without overwriting each other. Scalar keys inside a
 * plugin namespace use last-wins semantics.
 */
function mergeMessageMeta(
  acc: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!acc) {
    return next;
  }
  if (!next) {
    return acc;
  }
  const merged: Record<string, unknown> = { ...acc };
  for (const key of Object.keys(next)) {
    const accVal = acc[key];
    const nextVal = next[key];
    // Deep-merge plugin namespace objects (e.g. acc["memory-lancedb"] + next["memory-lancedb"])
    if (
      accVal &&
      nextVal &&
      typeof accVal === "object" &&
      !Array.isArray(accVal) &&
      typeof nextVal === "object" &&
      !Array.isArray(nextVal)
    ) {
      const innerMerged: Record<string, unknown> = {
        ...(accVal as Record<string, unknown>),
      };
      for (const innerKey of Object.keys(nextVal as Record<string, unknown>)) {
        const a = (accVal as Record<string, unknown>)[innerKey];
        const b = (nextVal as Record<string, unknown>)[innerKey];
        if (Array.isArray(a) && Array.isArray(b)) {
          innerMerged[innerKey] = [...a, ...b];
        } else {
          innerMerged[innerKey] = b;
        }
      }
      merged[key] = innerMerged;
    } else {
      merged[key] = nextVal;
    }
  }
  return merged;
}

/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry: PluginRegistry, options: HookRunnerOptions = {}) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;

  const mergeBeforeModelResolve = (
    acc: PluginHookBeforeModelResolveResult | undefined,
    next: PluginHookBeforeModelResolveResult,
  ): PluginHookBeforeModelResolveResult => ({
    // Keep the first defined override so higher-priority hooks win.
    modelOverride: acc?.modelOverride ?? next.modelOverride,
    providerOverride: acc?.providerOverride ?? next.providerOverride,
  });

  const mergeBeforePromptBuild = (
    acc: PluginHookBeforePromptBuildResult | undefined,
    next: PluginHookBeforePromptBuildResult,
  ): PluginHookBeforePromptBuildResult => ({
    systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
    prependContext: concatOptionalTextSegments({
      left: acc?.prependContext,
      right: next.prependContext,
    }),
    prependSystemContext: concatOptionalTextSegments({
      left: acc?.prependSystemContext,
      right: next.prependSystemContext,
    }),
    appendSystemContext: concatOptionalTextSegments({
      left: acc?.appendSystemContext,
      right: next.appendSystemContext,
    }),
    messageMeta: mergeMessageMeta(acc?.messageMeta, next.messageMeta),
  });

  const mergeSubagentSpawningResult = (
    acc: PluginHookSubagentSpawningResult | undefined,
    next: PluginHookSubagentSpawningResult,
  ): PluginHookSubagentSpawningResult => {
    if (acc?.status === "error") {
      return acc;
    }
    if (next.status === "error") {
      return next;
    }
    return {
      status: "ok",
      threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady),
    };
  };

  const mergeSubagentDeliveryTargetResult = (
    acc: PluginHookSubagentDeliveryTargetResult | undefined,
    next: PluginHookSubagentDeliveryTargetResult,
  ): PluginHookSubagentDeliveryTargetResult => {
    if (acc?.origin) {
      return acc;
    }
    return next;
  };

  const handleHookError = (params: {
    hookName: PluginHookName;
    pluginId: string;
    error: unknown;
  }): never | void => {
    const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${String(
      params.error,
    )}`;
    if (catchErrors) {
      logger?.error(msg);
      return;
    }
    throw new Error(msg, { cause: params.error });
  };

  const sanitizeHookError = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split("\n")[0]?.trim();
    return firstLine || "unknown error";
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
        await (hook.handler as (event: unknown, ctx: unknown) => Promise<void>)(event, ctx);
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
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
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    return result;
  }

  /**
   * Run a sequential claim hook where the first `{ handled: true }` result wins.
   */
  async function runClaimingHook<K extends PluginHookName, TResult extends { handled: boolean }>(
    hookName: K,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName(registry, hookName);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);

    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>
        )(event, ctx);
        if (handlerResult?.handled) {
          return handlerResult;
        }
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    return undefined;
  }

  async function runClaimingHookForPlugin<
    K extends PluginHookName,
    TResult extends { handled: boolean },
  >(
    hookName: K,
    pluginId: string,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<TResult | undefined> {
    const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
    if (hooks.length === 0) {
      return undefined;
    }

    logger?.debug?.(
      `[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted)`,
    );

    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>
        )(event, ctx);
        if (handlerResult?.handled) {
          return handlerResult;
        }
      } catch (err) {
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    return undefined;
  }

  async function runClaimingHookForPluginOutcome<
    K extends PluginHookName,
    TResult extends { handled: boolean },
  >(
    hookName: K,
    pluginId: string,
    event: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[0],
    ctx: Parameters<NonNullable<PluginHookRegistration<K>["handler"]>>[1],
  ): Promise<
    | { status: "handled"; result: TResult }
    | { status: "missing_plugin" }
    | { status: "no_handler" }
    | { status: "declined" }
    | { status: "error"; error: string }
  > {
    const pluginLoaded = registry.plugins.some(
      (plugin) => plugin.id === pluginId && plugin.status === "loaded",
    );
    if (!pluginLoaded) {
      return { status: "missing_plugin" };
    }

    const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
    if (hooks.length === 0) {
      return { status: "no_handler" };
    }

    logger?.debug?.(
      `[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted outcome)`,
    );

    let firstError: string | null = null;
    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown, ctx: unknown) => Promise<TResult | void>
        )(event, ctx);
        if (handlerResult?.handled) {
          return { status: "handled", result: handlerResult };
        }
      } catch (err) {
        firstError ??= sanitizeHookError(err);
        handleHookError({ hookName, pluginId: hook.pluginId, error: err });
      }
    }

    if (firstError) {
      return { status: "error", error: firstError };
    }
    return { status: "declined" };
  }

  // =========================================================================
  // Agent Hooks
  // =========================================================================

  /**
   * Run before_model_resolve hook.
   * Allows plugins to override provider/model before model resolution.
   */
  async function runBeforeModelResolve(
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeModelResolveResult | undefined> {
    return runModifyingHook<"before_model_resolve", PluginHookBeforeModelResolveResult>(
      "before_model_resolve",
      event,
      ctx,
      mergeBeforeModelResolve,
    );
  }

  /**
   * Run before_prompt_build hook.
   * Allows plugins to inject context and system prompt before prompt submission.
   */
  async function runBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforePromptBuildResult | undefined> {
    return runModifyingHook<"before_prompt_build", PluginHookBeforePromptBuildResult>(
      "before_prompt_build",
      event,
      ctx,
      mergeBeforePromptBuild,
    );
  }

  /**
   * Run before_agent_start hook.
   * Legacy compatibility hook that combines model resolve + prompt build phases.
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
        ...mergeBeforePromptBuild(acc, next),
        ...mergeBeforeModelResolve(acc, next),
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
   * Run inbound_claim hook.
   * Allows plugins to claim an inbound event before commands/agent dispatch.
   */
  async function runInboundClaim(
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | undefined> {
    return runClaimingHook<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      event,
      ctx,
    );
  }

  async function runInboundClaimForPlugin(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | undefined> {
    return runClaimingHookForPlugin<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      pluginId,
      event,
      ctx,
    );
  }

  async function runInboundClaimForPluginOutcome(
    pluginId: string,
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginTargetedInboundClaimOutcome> {
    return runClaimingHookForPluginOutcome<"inbound_claim", PluginHookInboundClaimResult>(
      "inbound_claim",
      pluginId,
      event,
      ctx,
    );
  }

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
  // Message Write Hooks
  // =========================================================================

  /**
   * Run before_message_write hook.
   *
   * This hook is intentionally synchronous: it runs on the hot path where
   * session transcripts are appended synchronously.
   *
   * Handlers are executed sequentially in priority order (higher first).
   * If any handler returns { block: true }, the message is NOT written
   * to the session JSONL and we return immediately.
   * If a handler returns { message }, the modified message replaces the
   * original for subsequent handlers and the final write.
   */
  function runBeforeMessageWrite(
    event: PluginHookBeforeMessageWriteEvent,
    ctx: { agentId?: string; sessionKey?: string },
  ): PluginHookBeforeMessageWriteResult | undefined {
    const hooks = getHooksForName(registry, "before_message_write");
    if (hooks.length === 0) {
      return undefined;
    }

    let current = event.message;

    for (const hook of hooks) {
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const out = (hook.handler as any)({ ...event, message: current }, ctx) as
          | PluginHookBeforeMessageWriteResult
          | void
          | Promise<unknown>;

        // Guard against accidental async handlers (this hook is sync-only).
        // oxlint-disable-next-line typescript/no-explicit-any
        if (out && typeof (out as any).then === "function") {
          const msg =
            `[hooks] before_message_write handler from ${hook.pluginId} returned a Promise; ` +
            `this hook is synchronous and the result was ignored.`;
          if (catchErrors) {
            logger?.warn?.(msg);
            continue;
          }
          throw new Error(msg);
        }

        const result = out as PluginHookBeforeMessageWriteResult | undefined;

        // If any handler blocks, return immediately.
        if (result?.block) {
          return { block: true };
        }

        // If handler provided a modified message, use it for subsequent handlers.
        if (result?.message) {
          current = result.message;
        }
      } catch (err) {
        const msg = `[hooks] before_message_write handler from ${hook.pluginId} failed: ${String(err)}`;
        if (catchErrors) {
          logger?.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    // If message was modified by any handler, return it.
    if (current !== event.message) {
      return { message: current };
    }

    return undefined;
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

  /**
   * Run subagent_spawning hook.
   * Runs sequentially so channel plugins can deterministically provision session bindings.
   */
  async function runSubagentSpawning(
    event: PluginHookSubagentSpawningEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<PluginHookSubagentSpawningResult | undefined> {
    return runModifyingHook<"subagent_spawning", PluginHookSubagentSpawningResult>(
      "subagent_spawning",
      event,
      ctx,
      mergeSubagentSpawningResult,
    );
  }

  /**
   * Run subagent_delivery_target hook.
   * Runs sequentially so channel plugins can deterministically resolve routing.
   */
  async function runSubagentDeliveryTarget(
    event: PluginHookSubagentDeliveryTargetEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<PluginHookSubagentDeliveryTargetResult | undefined> {
    return runModifyingHook<"subagent_delivery_target", PluginHookSubagentDeliveryTargetResult>(
      "subagent_delivery_target",
      event,
      ctx,
      mergeSubagentDeliveryTargetResult,
    );
  }

  /**
   * Run subagent_spawned hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSubagentSpawned(
    event: PluginHookSubagentSpawnedEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<void> {
    return runVoidHook("subagent_spawned", event, ctx);
  }

  /**
   * Run subagent_ended hook.
   * Runs in parallel (fire-and-forget).
   */
  async function runSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: PluginHookSubagentContext,
  ): Promise<void> {
    return runVoidHook("subagent_ended", event, ctx);
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
    runBeforeModelResolve,
    runBeforePromptBuild,
    runBeforeAgentStart,
    runLlmInput,
    runLlmOutput,
    runAgentEnd,
    runBeforeCompaction,
    runAfterCompaction,
    runBeforeReset,
    // Message hooks
    runInboundClaim,
    runInboundClaimForPlugin,
    runInboundClaimForPluginOutcome,
    runMessageReceived,
    runMessageSending,
    runMessageSent,
    // Tool hooks
    runBeforeToolCall,
    runAfterToolCall,
    runToolResultPersist,
    // Message write hooks
    runBeforeMessageWrite,
    // Session hooks
    runSessionStart,
    runSessionEnd,
    runSubagentSpawning,
    runSubagentDeliveryTarget,
    runSubagentSpawned,
    runSubagentEnded,
    // Gateway hooks
    runGatewayStart,
    runGatewayStop,
    // Utility
    hasHooks,
    getHookCount,
  };
}

export type HookRunner = ReturnType<typeof createHookRunner>;
