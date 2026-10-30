const GATEWAY_RETRY_INITIAL_DELAY_MS = 30_000;
const GATEWAY_RETRY_MAX_DELAY_MS = 5 * 60_000;

/** Owns one reconnect-safe retry timer and its bounded exponential backoff. */
export function createGatewayRetryOwner() {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let nextDelayMs = GATEWAY_RETRY_INITIAL_DELAY_MS;

  let pending: { callback: () => void; deadline: number } | undefined;
  const pause = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const cancel = () => {
    pause();
    pending = undefined;
  };
  const resume = () => {
    const scheduled = pending;
    if (!scheduled) {
      return false;
    }
    if (timer === null) {
      timer = globalThis.setTimeout(
        () => {
          timer = null;
          if (pending === scheduled) {
            pending = undefined;
            scheduled.callback();
          }
        },
        Math.max(0, scheduled.deadline - Date.now()),
      );
    }
    return true;
  };

  return {
    cancel,
    pause,
    resume,
    reset(this: void) {
      cancel();
      nextDelayMs = GATEWAY_RETRY_INITIAL_DELAY_MS;
    },
    schedule(this: void, retry: () => void, retryAfterMs = 0) {
      cancel();
      const minimum = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
      const delayMs = Math.min(2_147_483_647, Math.max(nextDelayMs, minimum));
      nextDelayMs = Math.min(nextDelayMs * 2, GATEWAY_RETRY_MAX_DELAY_MS);
      pending = { callback: retry, deadline: Date.now() + delayMs };
      resume();
    },
  };
}
