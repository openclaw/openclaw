export function createTypingKeepaliveLoop(params) {
    let timer;
    let tickInFlight = false;
    const tick = async () => {
        if (tickInFlight) {
            return;
        }
        tickInFlight = true;
        try {
            await params.onTick();
        }
        finally {
            tickInFlight = false;
        }
    };
    const start = () => {
        if (params.intervalMs <= 0 || timer) {
            return;
        }
        timer = setInterval(() => {
            void tick();
        }, params.intervalMs);
    };
    const stop = () => {
        if (!timer) {
            return;
        }
        clearInterval(timer);
        timer = undefined;
        tickInFlight = false;
    };
    const isRunning = () => timer !== undefined;
    return {
        tick,
        start,
        stop,
        isRunning,
    };
}
