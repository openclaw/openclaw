type AsyncTick = () => Promise<void> | void;

const MAX_CONSECUTIVE_ERRORS = 3;

export type TypingKeepaliveLoop = {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
};

export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: AsyncTick;
  maxConsecutiveErrors?: number;
}): TypingKeepaliveLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;
  let consecutiveErrors = 0;
  const errorThreshold = params.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;

  const stop = () => {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
    tickInFlight = false;
  };

  const tick = async () => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await params.onTick();
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= errorThreshold) {
        stop();
      }
    } finally {
      tickInFlight = false;
    }
  };

  const start = () => {
    if (params.intervalMs <= 0 || timer) {
      return;
    }
    consecutiveErrors = 0;
    timer = setInterval(() => {
      void tick();
    }, params.intervalMs);
  };

  const isRunning = () => timer !== undefined;

  return {
    tick,
    start,
    stop,
    isRunning,
  };
}
