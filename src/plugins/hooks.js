/**
 * Plugin Hook Runner
 *
 * Provides utilities for executing plugin lifecycle hooks with proper
 * error handling, priority ordering, and async support.
 */
/**
 * Get hooks for a specific hook name, sorted by priority (higher first).
 */
function getHooksForName(registry, hookName) {
    return registry.typedHooks
        .filter((h) => h.hookName === hookName)
        .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
/**
 * Create a hook runner for a specific registry.
 */
export function createHookRunner(registry, options = {}) {
    const logger = options.logger;
    const catchErrors = options.catchErrors ?? true;
    const mergeBeforeModelResolve = (acc, next) => ({
        // Keep the first defined override so higher-priority hooks win.
        modelOverride: acc?.modelOverride ?? next.modelOverride,
        providerOverride: acc?.providerOverride ?? next.providerOverride,
    });
    const mergeBeforePromptBuild = (acc, next) => ({
        systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
        prependContext: acc?.prependContext && next.prependContext
            ? `${acc.prependContext}\n\n${next.prependContext}`
            : (next.prependContext ?? acc?.prependContext),
    });
    const mergeSubagentSpawningResult = (acc, next) => {
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
    const mergeSubagentDeliveryTargetResult = (acc, next) => {
        if (acc?.origin) {
            return acc;
        }
        return next;
    };
    const handleHookError = (params) => {
        const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${String(params.error)}`;
        if (catchErrors) {
            logger?.error(msg);
            return;
        }
        throw new Error(msg, { cause: params.error });
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
    async function runModifyingHook(hookName, event, ctx, mergeResults) {
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
                    if (mergeResults && result !== undefined) {
                        result = mergeResults(result, handlerResult);
                    }
                    else {
                        result = handlerResult;
                    }
                }
            }
            catch (err) {
                handleHookError({ hookName, pluginId: hook.pluginId, error: err });
            }
        }
        return result;
    }
    // =========================================================================
    // Agent Hooks
    // =========================================================================
    /**
     * Run before_model_resolve hook.
     * Allows plugins to override provider/model before model resolution.
     */
    async function runBeforeModelResolve(event, ctx) {
        return runModifyingHook("before_model_resolve", event, ctx, mergeBeforeModelResolve);
    }
    /**
     * Run before_prompt_build hook.
     * Allows plugins to inject context and system prompt before prompt submission.
     */
    async function runBeforePromptBuild(event, ctx) {
        return runModifyingHook("before_prompt_build", event, ctx, mergeBeforePromptBuild);
    }
    /**
     * Run before_agent_start hook.
     * Legacy compatibility hook that combines model resolve + prompt build phases.
     */
    async function runBeforeAgentStart(event, ctx) {
        return runModifyingHook("before_agent_start", event, ctx, (acc, next) => ({
            ...mergeBeforePromptBuild(acc, next),
            ...mergeBeforeModelResolve(acc, next),
        }));
    }
    /**
     * Run agent_end hook.
     * Allows plugins to analyze completed conversations.
     * Runs in parallel (fire-and-forget).
     */
    async function runAgentEnd(event, ctx) {
        return runVoidHook("agent_end", event, ctx);
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
     * Run message_received hook.
     * Runs in parallel (fire-and-forget).
     */
    async function runMessageReceived(event, ctx) {
        return runVoidHook("message_received", event, ctx);
    }
    /**
     * Run message_sending hook.
     * Allows plugins to modify or cancel outgoing messages.
     * Runs sequentially.
     */
    async function runMessageSending(event, ctx) {
        return runModifyingHook("message_sending", event, ctx, (acc, next) => ({
            content: next.content ?? acc?.content,
            cancel: next.cancel ?? acc?.cancel,
        }));
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
        return runModifyingHook("before_tool_call", event, ctx, (acc, next) => ({
            params: next.params ?? acc?.params,
            block: next.block ?? acc?.block,
            blockReason: next.blockReason ?? acc?.blockReason,
        }));
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
                // oxlint-disable-next-line typescript/no-explicit-any
                const out = hook.handler({ ...event, message: current }, ctx);
                // Guard against accidental async handlers (this hook is sync-only).
                // oxlint-disable-next-line typescript/no-explicit-any
                if (out && typeof out.then === "function") {
                    const msg = `[hooks] tool_result_persist handler from ${hook.pluginId} returned a Promise; ` +
                        `this hook is synchronous and the result was ignored.`;
                    if (catchErrors) {
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
                if (catchErrors) {
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
                // oxlint-disable-next-line typescript/no-explicit-any
                const out = hook.handler({ ...event, message: current }, ctx);
                // Guard against accidental async handlers (this hook is sync-only).
                // oxlint-disable-next-line typescript/no-explicit-any
                if (out && typeof out.then === "function") {
                    const msg = `[hooks] before_message_write handler from ${hook.pluginId} returned a Promise; ` +
                        `this hook is synchronous and the result was ignored.`;
                    if (catchErrors) {
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
                if (catchErrors) {
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
        return runModifyingHook("subagent_spawning", event, ctx, mergeSubagentSpawningResult);
    }
    /**
     * Run subagent_delivery_target hook.
     * Runs sequentially so channel plugins can deterministically resolve routing.
     */
    async function runSubagentDeliveryTarget(event, ctx) {
        return runModifyingHook("subagent_delivery_target", event, ctx, mergeSubagentDeliveryTargetResult);
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
        runLlmInput,
        runLlmOutput,
        runAgentEnd,
        runBeforeCompaction,
        runAfterCompaction,
        runBeforeReset,
        // Message hooks
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
