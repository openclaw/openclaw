import { sleep } from "../../utils.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;
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
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function normalizeReplyPayloadInternal(payload, opts) {
    // Prefer dynamic context provider over static context
    const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;
    return normalizeReplyPayload(payload, {
        responsePrefix: opts.responsePrefix,
        responsePrefixContext: prefixContext,
        onHeartbeatStrip: opts.onHeartbeatStrip,
        onSkip: opts.onSkip,
    });
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
    // Register this dispatcher globally for gateway restart coordination.
    const { unregister } = registerDispatcher({
        pending: () => pending,
        waitForIdle: () => sendChain,
    });
    const enqueue = (kind, payload) => {
        const normalized = normalizeReplyPayloadInternal(payload, {
            responsePrefix: options.responsePrefix,
            responsePrefixContext: options.responsePrefixContext,
            responsePrefixContextProvider: options.responsePrefixContextProvider,
            onHeartbeatStrip: options.onHeartbeatStrip,
            onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
        });
        if (!normalized) {
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
            // Safe: deliver is called inside an async .then() callback, so even a synchronous
            // throw becomes a rejection that flows through .catch()/.finally(), ensuring cleanup.
            await options.deliver(normalized, { kind });
        })
            .catch((err) => {
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
    };
}
