type AsyncTick = () => Promise<void> | void;

type TypingKeepaliveLoop = {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
};

/** Creates a non-overlapping keepalive loop for platform typing refresh calls. */
export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: AsyncTick;
}): TypingKeepaliveLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }
    // Typing adapters can be slow or rate-limited; skip overlapping ticks
    // instead of building an unbounded queue of refresh calls.
    tickInFlight = true;
    try {
      await params.onTick();
    } finally {
      tickInFlight = false;
    }
  };

  const start = () => {
    if (params.intervalMs <= 0 || timer) {
      return;
    }
    // intervalMs <= 0 intentionally disables keepalive while still allowing
    // the initial typing start call from the owning callback.
    timer = setInterval(() => {
      void tick();
    }, params.intervalMs);
    timer.unref?.();
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
