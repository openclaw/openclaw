export function createArmableStallWatchdog(params) {
    const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
    const checkIntervalMs = Math.max(100, Math.floor(params.checkIntervalMs ?? Math.min(5000, Math.max(250, timeoutMs / 6))));
    let armed = false;
    let stopped = false;
    let lastActivityAt = Date.now();
    let timer = null;
    const clearTimer = () => {
        if (!timer) {
            return;
        }
        clearInterval(timer);
        timer = null;
    };
    const disarm = () => {
        armed = false;
    };
    const stop = () => {
        if (stopped) {
            return;
        }
        stopped = true;
        disarm();
        clearTimer();
        params.abortSignal?.removeEventListener("abort", stop);
    };
    const arm = (atMs) => {
        if (stopped) {
            return;
        }
        lastActivityAt = atMs ?? Date.now();
        armed = true;
    };
    const touch = (atMs) => {
        if (stopped) {
            return;
        }
        lastActivityAt = atMs ?? Date.now();
    };
    const check = () => {
        if (!armed || stopped) {
            return;
        }
        const now = Date.now();
        const idleMs = now - lastActivityAt;
        if (idleMs < timeoutMs) {
            return;
        }
        disarm();
        params.runtime?.error?.(`[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1000)}s (limit ${Math.round(timeoutMs / 1000)}s)`);
        params.onTimeout({ idleMs, timeoutMs });
    };
    if (params.abortSignal?.aborted) {
        stop();
    }
    else {
        params.abortSignal?.addEventListener("abort", stop, { once: true });
        timer = setInterval(check, checkIntervalMs);
        timer.unref?.();
    }
    return {
        arm,
        touch,
        disarm,
        stop,
        isArmed: () => armed,
    };
}
