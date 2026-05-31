type AsyncTick = () => Promise<void> | void;

type TypingKeepaliveLoop = {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
};

/** Creates a non-overlapping interval loop for refreshing channel typing indicators. */
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
    // Typing transports can be slow; skip overlapping ticks so a stuck refresh
    // cannot build an unbounded queue of start calls.
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
