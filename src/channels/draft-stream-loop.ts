import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Throttled draft streaming loop for preview send/edit updates. */
export type DraftStreamLoop = {
  /** Queue the latest draft text and schedule a send/edit when allowed by throttle state. */
  update: (text: string) => void;
  /** Immediately flush the latest pending text, waiting for any in-flight send first. */
  flush: () => Promise<void>;
  /** Stop future sends and clear any pending timer/text. */
  stop: () => void;
  /** Clear pending text without changing throttle or in-flight state. */
  resetPending: () => void;
  /** Reset throttle timing and cancel the pending timer. */
  resetThrottleWindow: () => void;
  /** Wait for the current send/edit promise without flushing pending text. */
  waitForInFlight: () => Promise<void>;
};

/** Creates a throttled stream loop that serializes draft preview send/edit calls. */
export function createDraftStreamLoop(params: {
  /** Minimum delay between successful send/edit attempts. */
  throttleMs: number;
  /** Stop predicate checked before every flush iteration. */
  isStopped: () => boolean;
  /** Sends or edits the current draft text; false keeps the text pending for retry. */
  sendOrEditStreamMessage: (text: string) => Promise<void | boolean>;
  /** Background flush error sink used to avoid unhandled promise rejections. */
  onBackgroundFlushError?: (err: unknown) => void;
}): DraftStreamLoop {
  const throttleMs = resolveTimerTimeoutMs(params.throttleMs, 0, 0);
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<void | boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
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
      let current: Promise<void | boolean> | undefined;
      try {
        current = Promise.resolve(params.sendOrEditStreamMessage(text)).finally(() => {
          if (inFlightPromise === current) {
            inFlightPromise = undefined;
          }
        });
      } catch (err) {
        pendingText ||= text;
        throw err;
      }
      inFlightPromise = current;
      let sent: void | boolean;
      try {
        sent = await current;
      } catch (err) {
        pendingText ||= text;
        throw err;
      }
      if (sent === false) {
        // A false result means the adapter declined this update without throwing; keep it pending
        // so a later explicit flush can retry the same latest text.
        pendingText = text;
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) {
        return;
      }
    }
  };

  const startBackgroundFlush = () => {
    void flush().catch((err: unknown) => {
      try {
        params.onBackgroundFlushError?.(err);
      } catch {
        // Error reporting must not recreate the unhandled background rejection path.
      }
    });
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      startBackgroundFlush();
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
      if (!timer && Date.now() - lastSentAt >= throttleMs) {
        startBackgroundFlush();
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
