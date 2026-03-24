export type DraftStreamLoop = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  resetPending: () => void;
  resetThrottleWindow: () => void;
  waitForInFlight: () => Promise<void>;
};

type DraftStreamSendResult = boolean | "reschedule";

export function createDraftStreamLoop(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendOrEditStreamMessage: (text: string) => Promise<void | DraftStreamSendResult>;
}): DraftStreamLoop {
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<void | DraftStreamSendResult> | undefined;
  let flushPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runFlush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = "";
        return;
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
        return;
      }
      lastSentAt = Date.now();
      if (sent === "reschedule") {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (pendingText) {
          schedule();
        }
        return;
      }
      if (!pendingText) {
        return;
      }
    }
  };

  const flush = () => {
    if (flushPromise) {
      return flushPromise;
    }
    const current = runFlush().finally(() => {
      if (flushPromise === current) {
        flushPromise = undefined;
      }
    });
    flushPromise = current;
    return current;
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
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
        void flush();
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
      }
    },
    waitForInFlight: async () => {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
  };
}
