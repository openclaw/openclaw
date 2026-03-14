type AsyncTick = () => Promise<void> | void;

export type TypingKeepaliveLoop = {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
};

const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;

export function createTypingKeepaliveLoop(params: {
  intervalMs: number;
  onTick: AsyncTick;
  /** Stop the loop after this many consecutive tick errors (default: 3). */
  maxConsecutiveErrors?: number;
}): TypingKeepaliveLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;
  let consecutiveErrors = 0;
  const maxErrors = params.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await params.onTick();
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxErrors) {
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
