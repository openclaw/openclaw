import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import { generateSecureInt } from "../../infra/secure-random.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSilentReplyRewriteText, } from "../../shared/silent-reply-policy.js";
import { sleep } from "../../utils.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
const silentReplyLogger = createSubsystemLogger("silent-reply/dispatcher");
/** Generate a random delay within the configured range. */
function getHumanDelay(config) {
    const mode = config?.mode ?? "off";
    if (mode === "off") {
        return 0;
    }
    const min = mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
    const max = mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
    if (max <= min) {
        return min;
    }
    return min + generateSecureInt(max - min + 1);
}
function normalizeReplyPayloadInternal(payload, opts) {
    // Prefer dynamic context provider over static context
    const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;
    return normalizeReplyPayload(payload, {
        responsePrefix: opts.responsePrefix,
        responsePrefixContext: prefixContext,
        onHeartbeatStrip: opts.onHeartbeatStrip,
        transformReplyPayload: opts.transformReplyPayload,
        onSkip: opts.onSkip,
    });
}
function resolveSilentFinalPayload(params) {
    if (params.kind !== "final") {
        return undefined;
    }
    if (!isSilentReplyText(params.payload.text, SILENT_REPLY_TOKEN)) {
        return undefined;
    }
    const context = params.silentReplyContext;
    if (!context) {
        return undefined;
    }
    const resolvedSettings = resolveSilentReplySettings({
        cfg: context.cfg,
        sessionKey: context.sessionKey,
        surface: context.surface,
        conversationType: context.conversationType,
    });
    if (resolvedSettings.policy === "allow") {
        return undefined;
    }
    if (resolvedSettings.rewrite) {
        silentReplyLogger.debug("rewriting exact NO_REPLY final payload before delivery", {
            hasSessionKey: Boolean(context.sessionKey),
            surface: context.surface,
            conversationType: context.conversationType,
            resolvedPolicy: resolvedSettings.policy,
        });
        return {
            ...params.payload,
            text: resolveSilentReplyRewriteText({
                seed: `${context.sessionKey ?? context.surface ?? "silent-reply"}:${params.payload.text ?? ""}`,
            }),
        };
    }
    if (!resolvedSettings.rewrite) {
        silentReplyLogger.debug("preserving exact NO_REPLY final payload before normalization", {
            hasSessionKey: Boolean(context.sessionKey),
            surface: context.surface,
            conversationType: context.conversationType,
            resolvedPolicy: resolvedSettings.policy,
        });
    }
    return {
        ...params.payload,
        text: params.payload.text?.trim() || SILENT_REPLY_TOKEN,
    };
}
export function createReplyDispatcher(options) {
    let sendChain = Promise.resolve();
    // Track in-flight deliveries so we can emit a reliable "idle" signal.
    // Start with pending=1 as a "reservation" to prevent premature gateway restart.
    // This is decremented when markComplete() is called to signal no more replies will come.
    let pending = 1;
    let completeCalled = false;
    // Track whether we've sent a block reply (for human delay - skip delay on first block).
    let sentFirstBlock = false;
    // Serialize outbound replies to preserve tool/block/final order.
    const queuedCounts = {
        tool: 0,
        block: 0,
        final: 0,
    };
    const failedCounts = {
        tool: 0,
        block: 0,
        final: 0,
    };
    const cancelledCounts = {
        tool: 0,
        block: 0,
        final: 0,
    };
    // Register this dispatcher globally for gateway restart coordination.
    const { unregister } = registerDispatcher({
        pending: () => pending,
        waitForIdle: () => sendChain,
    });
    const enqueue = (kind, payload) => {
        const originalWasExactSilent = isSilentReplyText(payload.text, SILENT_REPLY_TOKEN);
        const silentFinalPayload = resolveSilentFinalPayload({
            kind,
            payload,
            silentReplyContext: options.silentReplyContext,
        });
        const normalized = silentFinalPayload ??
            normalizeReplyPayloadInternal(payload, {
                responsePrefix: options.responsePrefix,
                responsePrefixContext: options.responsePrefixContext,
                responsePrefixContextProvider: options.responsePrefixContextProvider,
                transformReplyPayload: options.transformReplyPayload,
                onHeartbeatStrip: options.onHeartbeatStrip,
                onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
            });
        if (!normalized) {
            if (kind === "final" && originalWasExactSilent) {
                silentReplyLogger.debug("exact NO_REPLY final payload was skipped before delivery", {
                    hasSessionKey: Boolean(options.silentReplyContext?.sessionKey),
                    surface: options.silentReplyContext?.surface,
                    conversationType: options.silentReplyContext?.conversationType,
                });
            }
            return false;
        }
        queuedCounts[kind] += 1;
        pending += 1;
        // Determine if we should add human-like delay (only for block replies after the first).
        const shouldDelay = kind === "block" && sentFirstBlock;
        if (kind === "block") {
            sentFirstBlock = true;
        }
        sendChain = sendChain
            .then(async () => {
            // Add human-like delay between block replies for natural rhythm.
            if (shouldDelay) {
                const delayMs = getHumanDelay(options.humanDelay);
                if (delayMs > 0) {
                    await sleep(delayMs);
                }
            }
            let deliverPayload = normalized;
            if (options.beforeDeliver) {
                deliverPayload = await options.beforeDeliver(normalized, { kind });
                if (!deliverPayload) {
                    cancelledCounts[kind] += 1;
                    return;
                }
            }
            await options.deliver(deliverPayload, { kind });
        })
            .catch((err) => {
            failedCounts[kind] += 1;
            options.onError?.(err, { kind });
        })
            .finally(() => {
            pending -= 1;
            // Clear reservation if:
            // 1. pending is now 1 (just the reservation left)
            // 2. markComplete has been called
            // 3. No more replies will be enqueued
            if (pending === 1 && completeCalled) {
                pending -= 1; // Clear the reservation
            }
            if (pending === 0) {
                // Unregister from global tracking when idle.
                unregister();
                options.onIdle?.();
            }
        });
        return true;
    };
    const markComplete = () => {
        if (completeCalled) {
            return;
        }
        completeCalled = true;
        // If no replies were enqueued (pending is still 1 = just the reservation),
        // schedule clearing the reservation after current microtasks complete.
        // This gives any in-flight enqueue() calls a chance to increment pending.
        void Promise.resolve().then(() => {
            if (pending === 1 && completeCalled) {
                // Still just the reservation, no replies were enqueued
                pending -= 1;
                if (pending === 0) {
                    unregister();
                    options.onIdle?.();
                }
            }
        });
    };
    return {
        sendToolResult: (payload) => enqueue("tool", payload),
        sendBlockReply: (payload) => enqueue("block", payload),
        sendFinalReply: (payload) => enqueue("final", payload),
        waitForIdle: () => sendChain,
        getQueuedCounts: () => ({ ...queuedCounts }),
        getCancelledCounts: () => ({ ...cancelledCounts }),
        getFailedCounts: () => ({ ...failedCounts }),
        markComplete,
    };
}
export function createReplyDispatcherWithTyping(options) {
    const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
    const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
    const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
    const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
    let typingController;
    const dispatcher = createReplyDispatcher({
        ...dispatcherOptions,
        onIdle: () => {
            typingController?.markDispatchIdle();
            resolvedOnIdle?.();
        },
    });
    return {
        dispatcher,
        replyOptions: {
            onReplyStart: resolvedOnReplyStart,
            onTypingCleanup: resolvedOnCleanup,
            onTypingController: (typing) => {
                typingController = typing;
            },
        },
        markDispatchIdle: () => {
            typingController?.markDispatchIdle();
            resolvedOnIdle?.();
        },
        markRunComplete: () => {
            typingController?.markRunComplete();
        },
    };
}
