import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";
import { createTypingStartGuard } from "./typing-start-guard.js";
export function createTypingCallbacks(params) {
    const stop = params.stop;
    const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3000;
    const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
    const maxDurationMs = params.maxDurationMs ?? 60000; // Default 60s TTL
    let stopSent = false;
    let closed = false;
    let ttlTimer;
    const startGuard = createTypingStartGuard({
        isSealed: () => closed,
        onStartError: params.onStartError,
        maxConsecutiveFailures,
        onTrip: () => {
            keepaliveLoop.stop();
        },
    });
    const fireStart = async () => {
        await startGuard.run(() => params.start());
    };
    const keepaliveLoop = createTypingKeepaliveLoop({
        intervalMs: keepaliveIntervalMs,
        onTick: fireStart,
    });
    // TTL safety: auto-stop typing after maxDurationMs
    const startTtlTimer = () => {
        if (maxDurationMs <= 0) {
            return;
        }
        clearTtlTimer();
        ttlTimer = setTimeout(() => {
            if (!closed) {
                console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
                fireStop();
            }
        }, maxDurationMs);
    };
    const clearTtlTimer = () => {
        if (ttlTimer) {
            clearTimeout(ttlTimer);
            ttlTimer = undefined;
        }
    };
    const onReplyStart = async () => {
        if (closed) {
            return;
        }
        stopSent = false;
        startGuard.reset();
        keepaliveLoop.stop();
        clearTtlTimer();
        await fireStart();
        if (startGuard.isTripped()) {
            return;
        }
        keepaliveLoop.start();
        startTtlTimer(); // Start TTL safety timer
    };
    const fireStop = () => {
        closed = true;
        keepaliveLoop.stop();
        clearTtlTimer(); // Clear TTL timer on normal stop
        if (!stop || stopSent) {
            return;
        }
        stopSent = true;
        void stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
    };
    return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}
