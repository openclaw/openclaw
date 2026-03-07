type AsyncTick = () => Promise<void> | void;

export type TypingKeepaliveLoop = {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
};

export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: AsyncTick;
}): TypingKeepaliveLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickInFlight = false;
  let stopped = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await params.onTick();
    } finally {
      tickInFlight = false;
    }
  };

  // Use setTimeout chain instead of setInterval for cleaner cleanup semantics.
  // Each tick schedules the next only after completion, avoiding timer pile-up.
  const scheduleNext = () => {
    if (stopped || params.intervalMs <= 0) {
      return;
    }
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) {
          scheduleNext();
        }
      });
    }, params.intervalMs);
  };

  const start = () => {
    if (params.intervalMs <= 0 || timer) {
      return;
    }
    stopped = false;
    scheduleNext();
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
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
