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
  let generation = 0; // Track active generation to prevent stale ticks from scheduling

  const tick = async () => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await params.onTick();
    } finally {
      // Always reset tickInFlight so future ticks can run
      // Generation check in scheduleNext prevents stale ticks from scheduling
      tickInFlight = false;
    }
  };

  // Use setTimeout chain instead of setInterval for cleaner cleanup semantics.
  // Each tick schedules the next only after completion, avoiding timer pile-up.
  const scheduleNext = () => {
    if (stopped || params.intervalMs <= 0 || timer) {
      return;
    }
    timer = setTimeout(() => {
      // Capture current generation at schedule time
      const scheduledGeneration = generation;
      timer = undefined;
      void tick().finally(() => {
        // Only schedule next if we haven't been stopped AND
        // the generation hasn't changed (prevents stale ticks from scheduling)
        if (!stopped && generation === scheduledGeneration) {
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
    generation++; // Increment generation to invalidate any stale ticks
    scheduleNext();
  };

  const stop = () => {
    stopped = true;
    generation++; // Increment to invalidate any in-flight ticks
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    // Do NOT reset tickInFlight here - let the in-flight tick's finally block handle it
  };

  const isRunning = () => timer !== undefined;

  return {
    tick,
    start,
    stop,
    isRunning,
  };
}
