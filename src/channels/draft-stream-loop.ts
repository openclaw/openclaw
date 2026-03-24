export type DraftStreamLoop = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  resetPending: () => void;
  resetThrottleWindow: () => void;
  waitForInFlight: () => Promise<void>;
};

type DraftStreamSendResult = boolean | "reschedule";
type DraftStreamRunResult = "idle" | "blocked" | "rescheduled";

export function createDraftStreamLoop(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendOrEditStreamMessage: (text: string) => Promise<void | DraftStreamSendResult>;
}): DraftStreamLoop {
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<void | DraftStreamSendResult> | undefined;
  let runPromise: Promise<DraftStreamRunResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerWaiters: Array<() => void> = [];

  const resolveTimerWaiters = () => {
    const waiters = timerWaiters;
    timerWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const runFlush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      resolveTimerWaiters();
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = "";
        return "idle";
      }
      pendingText = "";
      const current = params.sendOrEditStreamMessage(text).finally(() => {
        if (inFlightPromise === current) {
          inFlightPromise = undefined;
        }
      });
      inFlightPromise = current;
      const sent = await current;
      if (sent === false) {
        pendingText = text;
        return "blocked";
      }
      lastSentAt = Date.now();
      if (sent === "reschedule") {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
          resolveTimerWaiters();
        }
        if (pendingText) {
          schedule();
        }
        return "rescheduled";
      }
      if (!pendingText) {
        return "idle";
      }
    }
    return "idle";
  };

  const ensureRun = () => {
    if (runPromise) {
      return runPromise;
    }
    const current = runFlush().finally(() => {
      if (runPromise === current) {
        runPromise = undefined;
      }
    });
    runPromise = current;
    return current;
  };

  const waitForScheduledRun = () => {
    if (!timer) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      timerWaiters.push(resolve);
    });
  };

  const flush = async () => {
    while (!params.isStopped()) {
      const result = await ensureRun();
      if (result !== "rescheduled") {
        return;
      }
      if (!pendingText.trim()) {
        pendingText = "";
        return;
      }
      await waitForScheduledRun();
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      resolveTimerWaiters();
      void ensureRun();
    }, delay);
  };

  return {
    update: (text: string) => {
      if (params.isStopped()) {
        return;
      }
      pendingText = text;
      if (inFlightPromise) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= params.throttleMs) {
        void ensureRun();
        return;
      }
      schedule();
    },
    flush,
    stop: () => {
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        resolveTimerWaiters();
      }
    },
    resetPending: () => {
      pendingText = "";
    },
    resetThrottleWindow: () => {
      lastSentAt = 0;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        resolveTimerWaiters();
      }
    },
    waitForInFlight: async () => {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
  };
}
