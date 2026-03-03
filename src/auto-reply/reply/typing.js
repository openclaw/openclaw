import { createTypingKeepaliveLoop } from "../../channels/typing-lifecycle.js";
import { createTypingStartGuard } from "../../channels/typing-start-guard.js";
import { isSilentReplyPrefixText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
export function createTypingController(params) {
    const { onReplyStart, onCleanup, typingIntervalSeconds = 6, typingTtlMs = 2 * 60000, silentToken = SILENT_REPLY_TOKEN, log, } = params;
    let started = false;
    let active = false;
    let runComplete = false;
    let dispatchIdle = false;
    // Important: callbacks (tool/block streaming) can fire late (after the run completed),
    // especially when upstream event emitters don't await async listeners.
    // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
    let sealed = false;
    let typingTtlTimer;
    const typingIntervalMs = typingIntervalSeconds * 1000;
    const formatTypingTtl = (ms) => {
        if (ms % 60000 === 0) {
            return `${ms / 60000}m`;
        }
        return `${Math.round(ms / 1000)}s`;
    };
    const resetCycle = () => {
        started = false;
        active = false;
        runComplete = false;
        dispatchIdle = false;
    };
    const cleanup = () => {
        if (sealed) {
            return;
        }
        if (typingTtlTimer) {
            clearTimeout(typingTtlTimer);
            typingTtlTimer = undefined;
        }
        if (dispatchIdleTimer) {
            clearTimeout(dispatchIdleTimer);
            dispatchIdleTimer = undefined;
        }
        typingLoop.stop();
        // Notify the channel to stop its typing indicator (e.g., on NO_REPLY).
        // This fires only once (sealed prevents re-entry).
        if (active) {
            onCleanup?.();
        }
        resetCycle();
        sealed = true;
    };
    const refreshTypingTtl = () => {
        if (sealed) {
            return;
        }
        if (!typingIntervalMs || typingIntervalMs <= 0) {
            return;
        }
        if (typingTtlMs <= 0) {
            return;
        }
        if (typingTtlTimer) {
            clearTimeout(typingTtlTimer);
        }
        typingTtlTimer = setTimeout(() => {
            if (!typingLoop.isRunning()) {
                return;
            }
            log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
            cleanup();
        }, typingTtlMs);
    };
    const isActive = () => active && !sealed;
    const startGuard = createTypingStartGuard({
        isSealed: () => sealed,
        shouldBlock: () => runComplete,
        rethrowOnError: true,
    });
    const triggerTyping = async () => {
        await startGuard.run(async () => {
            await onReplyStart?.();
        });
    };
    const typingLoop = createTypingKeepaliveLoop({
        intervalMs: typingIntervalMs,
        onTick: triggerTyping,
    });
    const ensureStart = async () => {
        if (sealed) {
            return;
        }
        // Late callbacks after a run completed should never restart typing.
        if (runComplete) {
            return;
        }
        if (!active) {
            active = true;
        }
        if (started) {
            return;
        }
        started = true;
        await triggerTyping();
    };
    const maybeStopOnIdle = () => {
        if (!active) {
            return;
        }
        // Stop only when the model run is done and the dispatcher queue is empty.
        if (runComplete && dispatchIdle) {
            cleanup();
        }
    };
    const startTypingLoop = async () => {
        if (sealed) {
            return;
        }
        if (runComplete) {
            return;
        }
        // Always refresh TTL when called, even if loop already running.
        // This keeps typing alive during long tool executions.
        refreshTypingTtl();
        if (!onReplyStart) {
            return;
        }
        if (typingLoop.isRunning()) {
            return;
        }
        await ensureStart();
        typingLoop.start();
    };
    const startTypingOnText = async (text) => {
        if (sealed) {
            return;
        }
        const trimmed = text?.trim();
        if (!trimmed) {
            return;
        }
        if (silentToken &&
            (isSilentReplyText(trimmed, silentToken) || isSilentReplyPrefixText(trimmed, silentToken))) {
            return;
        }
        refreshTypingTtl();
        await startTypingLoop();
    };
    let dispatchIdleTimer;
    const DISPATCH_IDLE_GRACE_MS = 10000;
    const markRunComplete = () => {
        runComplete = true;
        maybeStopOnIdle();
        if (!sealed && !dispatchIdle) {
            dispatchIdleTimer = setTimeout(() => {
                if (!sealed && !dispatchIdle) {
                    log?.("typing: dispatch idle not received after run complete; forcing cleanup");
                    cleanup();
                }
            }, DISPATCH_IDLE_GRACE_MS);
        }
    };
    const markDispatchIdle = () => {
        dispatchIdle = true;
        if (dispatchIdleTimer) {
            clearTimeout(dispatchIdleTimer);
            dispatchIdleTimer = undefined;
        }
        maybeStopOnIdle();
    };
    return {
        onReplyStart: ensureStart,
        startTypingLoop,
        startTypingOnText,
        refreshTypingTtl,
        isActive,
        markRunComplete,
        markDispatchIdle,
        cleanup,
    };
}
