/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */
import { formatHookErrorForLog } from "../hooks/fire-and-forget.js";
import { formatErrorMessage } from "../infra/errors.js";
import { concatOptionalTextSegments } from "../shared/text/join-segments.js";
/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooksForName(registry, hookName) {
    return registry.typedHooks
        .filter((h) => h.hookName === hookName)
        .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
function getHooksForNameAndPlugin(registry, hookName, pluginId) {
    return getHooksForName(registry, hookName).filter((hook) => hook.pluginId === pluginId);
}
/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry, options = {}) {
    const logger = options.logger;
    const catchErrors = options.catchErrors ?? true;
    const failurePolicyByHook = options.failurePolicyByHook ?? {};
    const shouldCatchHookErrors = (hookName) => catchErrors && (failurePolicyByHook[hookName] ?? "fail-open") === "fail-open";
    const firstDefined = (prev, next) => prev ?? next;
    const lastDefined = (prev, next) => next ?? prev;
    const stickyTrue = (prev, next) => prev === true || next === true ? true : undefined;
    const mergeBeforeModelResolve = (acc, next) => ({
        // Keep the first defined override so higher-priority hooks win.
        modelOverride: firstDefined(acc?.modelOverride, next.modelOverride),
        providerOverride: firstDefined(acc?.providerOverride, next.providerOverride),
    });
    const mergeBeforePromptBuild = (acc, next) => ({
        // Keep the first defined system prompt so higher-priority hooks win.
        systemPrompt: firstDefined(acc?.systemPrompt, next.systemPrompt),
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
    });
    const mergeSubagentSpawningResult = (acc, next) => {
        if (acc?.status === "error") {
            return acc;
        }
        if (next.status === "error") {
            return next;
        }
        const deliveryOrigin = acc?.deliveryOrigin ?? next.deliveryOrigin;
        return {
            status: "ok",
            threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady),
            ...(deliveryOrigin ? { deliveryOrigin } : {}),
        };
    };
    const mergeSubagentDeliveryTargetResult = (acc, next) => {
        if (acc?.origin) {
            return acc;
        }
        return next;
    };
    const handleHookError = (params) => {
        const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${formatHookErrorForLog(params.error)}`;
        if (shouldCatchHookErrors(params.hookName)) {
            logger?.error(msg);
            return;
        }
        throw new Error(msg, { cause: params.error });
    };
    const sanitizeHookError = (error) => {
        const raw = formatErrorMessage(error);
        const firstLine = raw.split("\n")[0]?.trim();
        return firstLine || "unknown error";
    };
    const isPromiseLike = (value) => {
        if ((typeof value !== "object" && typeof value !== "function") || value === null) {
            return false;
        }
        return typeof value.then === "function";
    };
    const runSyncHookHandler = (hook, event, ctx) => {
        const handler = hook.handler;
        return handler(event, ctx);
    };
    /**
     * Run a hook that doesn't return a value (fire-and-forget style).
     * All handlers are executed in parallel for performance.
     */
    async function runVoidHook(hookName, event, ctx) {
        const hooks = getHooksForName(registry, hookName);
        if (hooks.length === 0) {
            return;
        }
        logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);
        const promises = hooks.map(async (hook) => {
            try {
                await hook.handler(event, ctx);
            }
            catch (err) {
                handleHookError({ hookName, pluginId: hook.pluginId, error: err });
            }
        });
        await Promise.all(promises);
    }
    /**
     * Run a hook that can return a modifying result.
     * Handlers are executed sequentially in priority order, and results are merged.
     */
    async function runModifyingHook(hookName, event, ctx, policy = {}) {
        const hooks = getHooksForName(registry, hookName);
        if (hooks.length === 0) {
            return undefined;
        }
        logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);
        let result;
        for (const hook of hooks) {
            try {
                const handlerResult = await hook.handler(event, ctx);
                if (handlerResult !== undefined && handlerResult !== null) {
                    if (policy.mergeResults) {
                        result = policy.mergeResults(result, handlerResult, hook);
                    }
                    else {
                        result = handlerResult;
                    }
                    if (result && policy.shouldStop?.(result)) {
                        const terminalLabel = policy.terminalLabel ? ` ${policy.terminalLabel}` : "";
                        const priority = hook.priority ?? 0;
                        logger?.debug?.(`[hooks] ${hookName}${terminalLabel} decided by ${hook.pluginId} (priority=${priority}); skipping remaining handlers`);
                        policy.onTerminal?.({ hookName, pluginId: hook.pluginId, result });
                        break;
                    }
                }
            }
            catch (err) {
                handleHookError({ hookName, pluginId: hook.pluginId, error: err });
            }
        }
        return result;
    }
    /**
     * Run a sequential claim hook where the first `{ handled: true }` result wins.
     */
    async function runClaimingHook(hookName, event, ctx) {
        const hooks = getHooksForName(registry, hookName);
        if (hooks.length === 0) {
            return undefined;
        }
        logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);
        return await runClaimingHooksList(hooks, hookName, event, ctx);
    }
    async function runClaimingHookForPlugin(hookName, pluginId, event, ctx) {
        const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
        if (hooks.length === 0) {
            return undefined;
        }
        logger?.debug?.(`[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted)`);
        return await runClaimingHooksList(hooks, hookName, event, ctx);
    }
    async function runClaimingHooksList(hooks, hookName, event, ctx) {
        for (const hook of hooks) {
            try {
                const handlerResult = await hook.handler(event, ctx);
                if (handlerResult?.handled) {
                    return handlerResult;
                }
            }
            catch (err) {
                handleHookError({ hookName, pluginId: hook.pluginId, error: err });
            }
        }
        return undefined;
    }
    async function runClaimingHookForPluginOutcome(hookName, pluginId, event, ctx) {
        const pluginLoaded = registry.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded");
        if (!pluginLoaded) {
            return { status: "missing_plugin" };
        }
        const hooks = getHooksForNameAndPlugin(registry, hookName, pluginId);
        if (hooks.length === 0) {
            return { status: "no_handler" };
        }
        logger?.debug?.(`[hooks] running ${hookName} for ${pluginId} (${hooks.length} handlers, targeted outcome)`);
        let firstError = null;
        for (const hook of hooks) {
            try {
                const handlerResult = await hook.handler(event, ctx);
                if (handlerResult?.handled) {
                    return { status: "handled", result: handlerResult };
                }
            }
            catch (err) {
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
    function withAgentRunId(event, ctx) {
        if (event.runId || !ctx.runId) {
            return event;
        }
        return { ...event, runId: ctx.runId };
    }
    /**
     * Run before_model_resolve hook.
     * Allows plugins to override provider/model before model resolution.
     */
    async function runBeforeModelResolve(event, ctx) {
        return runModifyingHook("before_model_resolve", event, ctx, { mergeResults: mergeBeforeModelResolve });
    }
    /**
     * Run before_prompt_build hook.
     * Allows plugins to inject context and system prompt before prompt submission.
     */
    async function runBeforePromptBuild(event, ctx) {
        return runModifyingHook("before_prompt_build", event, ctx, { mergeResults: mergeBeforePromptBuild });
    }
    /**
     * Run before_agent_start hook.
     * Legacy compatibility hook that combines model resolve + prompt build phases.
     */
    async function runBeforeAgentStart(event, ctx) {
        return runModifyingHook("before_agent_start", withAgentRunId(event, ctx), ctx, {
            mergeResults: (acc, next) => ({
                ...mergeBeforePromptBuild(acc, next),
                ...mergeBeforeModelResolve(acc, next),
            }),
        });
    }
    /**
     * Run before_agent_reply hook.
     * Allows plugins to intercept messages and return a synthetic reply,
     * short-circuiting the LLM agent. First handler to return { handled: true } wins.
     */
    async function runBeforeAgentReply(event, ctx) {
        return runClaimingHook("before_agent_reply", event, ctx);
    }
    /**
     * Run model_call_started hook.
     * Allows plugins to observe sanitized model-call metadata.
     * Runs in parallel (fire-and-forget).
     */
    async function runModelCallStarted(event, ctx) {
        return runVoidHook("model_call_started", event, ctx);
    }
    /**
     * Run model_call_ended hook.
     * Allows plugins to observe sanitized terminal model-call metadata.
     * Runs in parallel (fire-and-forget).
     */
    async function runModelCallEnded(event, ctx) {
        return runVoidHook("model_call_ended", event, ctx);
    }
    /**
     * Run agent_end hook.
     * Allows plugins to analyze completed conversations.
     * Runs in parallel (fire-and-forget).
     */
    async function runAgentEnd(event, ctx) {
        return runVoidHook("agent_end", withAgentRunId(event, ctx), ctx);
    }
    /**
     * Run llm_input hook.
     * Allows plugins to observe the exact input payload sent to the LLM.
     * Runs in parallel (fire-and-forget).
     */
    async function runLlmInput(event, ctx) {
        return runVoidHook("llm_input", event, ctx);
    }
    /**
     * Run llm_output hook.
     * Allows plugins to observe the exact output payload returned by the LLM.
     * Runs in parallel (fire-and-forget).
     */
    async function runLlmOutput(event, ctx) {
        return runVoidHook("llm_output", event, ctx);
    }
    /**
     * Run before_compaction hook.
     */
    async function runBeforeCompaction(event, ctx) {
        return runVoidHook("before_compaction", event, ctx);
    }
    /**
     * Run after_compaction hook.
     */
    async function runAfterCompaction(event, ctx) {
        return runVoidHook("after_compaction", event, ctx);
    }
    /**
     * Run before_reset hook.
     * Fired when /new or /reset clears a session, before messages are lost.
     * Runs in parallel (fire-and-forget).
     */
    async function runBeforeReset(event, ctx) {
        return runVoidHook("before_reset", event, ctx);
    }
    // =========================================================================
    // Message Hooks
    // =========================================================================
    /**
     * Run inbound_claim hook.
     * Allows plugins to claim an inbound event before commands/agent dispatch.
     */
    async function runInboundClaim(event, ctx) {
        return runClaimingHook("inbound_claim", event, ctx);
    }
    async function runInboundClaimForPlugin(pluginId, event, ctx) {
        return runClaimingHookForPlugin("inbound_claim", pluginId, event, ctx);
    }
    async function runInboundClaimForPluginOutcome(pluginId, event, ctx) {
        return runClaimingHookForPluginOutcome("inbound_claim", pluginId, event, ctx);
    }
    /**
     * Run message_received hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runMessageReceived(event, ctx) {
        return runVoidHook("message_received", event, ctx);
    }
    /**
     * Run before_dispatch hook.
     * Allows plugins to inspect or handle a message before model dispatch.
     * First handler returning { handled: true } wins.
     */
    async function runBeforeDispatch(event, ctx) {
        return runClaimingHook("before_dispatch", event, ctx);
    }
    /**
     * Run reply_dispatch hook.
     * Allows plugins to own reply dispatch before the default model path runs.
     * First handler returning { handled: true } wins.
     */
    async function runReplyDispatch(event, ctx) {
        return runClaimingHook("reply_dispatch", event, ctx);
    }
    /**
     * Run message_sending hook.
     * Allows plugins to modify or cancel outgoing messages.
     * Runs sequentially.
     */
    async function runMessageSending(event, ctx) {
        return runModifyingHook("message_sending", event, ctx, {
            mergeResults: (acc, next) => {
                if (acc?.cancel === true) {
                    return acc;
                }
                return {
                    content: lastDefined(acc?.content, next.content),
                    cancel: stickyTrue(acc?.cancel, next.cancel),
                };
            },
            shouldStop: (result) => result.cancel === true,
            terminalLabel: "cancel=true",
        });
    }
    /**
     * Run message_sent hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runMessageSent(event, ctx) {
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
    async function runBeforeToolCall(event, ctx) {
        return runModifyingHook("before_tool_call", event, ctx, {
            mergeResults: (acc, next, reg) => {
                if (acc?.block === true) {
                    return acc;
                }
                const approvalPluginId = acc?.requireApproval?.pluginId;
                const freezeParamsForDifferentPlugin = Boolean(approvalPluginId) && approvalPluginId !== reg.pluginId;
                return {
                    params: freezeParamsForDifferentPlugin
                        ? acc?.params
                        : lastDefined(acc?.params, next.params),
                    block: stickyTrue(acc?.block, next.block),
                    blockReason: lastDefined(acc?.blockReason, next.blockReason),
                    requireApproval: acc?.requireApproval ??
                        (next.requireApproval
                            ? { ...next.requireApproval, pluginId: reg.pluginId }
                            : undefined),
                };
            },
            shouldStop: (result) => result.block === true,
            terminalLabel: "block=true",
        });
    }
    /**
     * Run after_tool_call hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runAfterToolCall(event, ctx) {
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
    function runToolResultPersist(event, ctx) {
        const hooks = getHooksForName(registry, "tool_result_persist");
        if (hooks.length === 0) {
            return undefined;
        }
        let current = event.message;
        for (const hook of hooks) {
            try {
                const out = runSyncHookHandler(hook, { ...event, message: current }, ctx);
                // Guard against accidental async handlers (this hook is sync-only).
                if (isPromiseLike(out)) {
                    const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} returned a Promise; ` +
                        `this hook is synchronous and the result was ignored.`;
                    if (shouldCatchHookErrors("tool_result_persist")) {
                        logger?.warn?.(msg);
                        continue;
                    }
                    throw new Error(msg);
                }
                const next = out?.message;
                if (next) {
                    current = next;
                }
            }
            catch (err) {
                const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} failed: ${String(err)}`;
                if (shouldCatchHookErrors("tool_result_persist")) {
                    logger?.error(msg);
                }
                else {
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
    function runBeforeMessageWrite(event, ctx) {
        const hooks = getHooksForName(registry, "before_message_write");
        if (hooks.length === 0) {
            return undefined;
        }
        let current = event.message;
        for (const hook of hooks) {
            try {
                const out = runSyncHookHandler(hook, { ...event, message: current }, ctx);
                // Guard against accidental async handlers (this hook is sync-only).
                if (isPromiseLike(out)) {
                    const msg = `[hooks] before_message_write handler from ${hook.pluginId} returned a Promise; ` +
                        `this hook is synchronous and the result was ignored.`;
                    if (shouldCatchHookErrors("before_message_write")) {
                        logger?.warn?.(msg);
                        continue;
                    }
                    throw new Error(msg);
                }
                const result = out;
                // If any handler blocks, return immediately.
                if (result?.block) {
                    return { block: true };
                }
                // If handler provided a modified message, use it for subsequent handlers.
                if (result?.message) {
                    current = result.message;
                }
            }
            catch (err) {
                const msg = `[hooks] before_message_write handler from ${hook.pluginId} failed: ${String(err)}`;
                if (shouldCatchHookErrors("before_message_write")) {
                    logger?.error(msg);
                }
                else {
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
    async function runSessionStart(event, ctx) {
        return runVoidHook("session_start", event, ctx);
    }
    /**
     * Run session_end hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runSessionEnd(event, ctx) {
        return runVoidHook("session_end", event, ctx);
    }
    /**
     * Run subagent_spawning hook.
     * Runs sequentially so channel plugins can deterministically provision session bindings.
     */
    async function runSubagentSpawning(event, ctx) {
        return runModifyingHook("subagent_spawning", event, ctx, { mergeResults: mergeSubagentSpawningResult });
    }
    /**
     * Run subagent_delivery_target hook.
     * Runs sequentially so channel plugins can deterministically resolve routing.
     */
    async function runSubagentDeliveryTarget(event, ctx) {
        return runModifyingHook("subagent_delivery_target", event, ctx, { mergeResults: mergeSubagentDeliveryTargetResult });
    }
    /**
     * Run subagent_spawned hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runSubagentSpawned(event, ctx) {
        return runVoidHook("subagent_spawned", event, ctx);
    }
    /**
     * Run subagent_ended hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runSubagentEnded(event, ctx) {
        return runVoidHook("subagent_ended", event, ctx);
    }
    // =========================================================================
    // Gateway Hooks
    // =========================================================================
    /**
     * Run gateway_start hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runGatewayStart(event, ctx) {
        return runVoidHook("gateway_start", event, ctx);
    }
    /**
     * Run gateway_stop hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runGatewayStop(event, ctx) {
        return runVoidHook("gateway_stop", event, ctx);
    }
    // =========================================================================
    // Skill Install Hooks
    // =========================================================================
    /**
     * Run before_install hook.
     * Allows plugins to augment scan findings or block installs.
     * Runs sequentially so higher-priority hooks can block before lower ones run.
     */
    async function runBeforeInstall(event, ctx) {
        return runModifyingHook("before_install", event, ctx, {
            mergeResults: (acc, next) => {
                if (acc?.block === true) {
                    return acc;
                }
                const mergedFindings = [...(acc?.findings ?? []), ...(next.findings ?? [])];
                return {
                    findings: mergedFindings.length > 0 ? mergedFindings : undefined,
                    block: stickyTrue(acc?.block, next.block),
                    blockReason: lastDefined(acc?.blockReason, next.blockReason),
                };
            },
            shouldStop: (result) => result.block === true,
            terminalLabel: "block=true",
        });
    }
    // =========================================================================
    // Utility
    // =========================================================================
    /**
     * Check if any hooks are registered for a given hook name.
     */
    function hasHooks(hookName) {
        return registry.typedHooks.some((h) => h.hookName === hookName);
    }
    /**
     * Get count of registered hooks for a given hook name.
     */
    function getHookCount(hookName) {
        return registry.typedHooks.filter((h) => h.hookName === hookName).length;
    }
    return {
        // Agent hooks
        runBeforeModelResolve,
        runBeforePromptBuild,
        runBeforeAgentStart,
        runBeforeAgentReply,
        runModelCallStarted,
        runModelCallEnded,
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
        runBeforeDispatch,
        runReplyDispatch,
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
        // Install hooks
        runBeforeInstall,
        // Utility
        hasHooks,
        getHookCount,
    };
}
