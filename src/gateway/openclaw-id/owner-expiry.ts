// An owner device and its bound node stop being admitted when its certificate expires.
// Independently approved descendants keep their own lifetimes. Admission checks the
// current certificate on every connection; this timer ends already-open sessions.

/** Longest delay Node timers accept; a later expiry re-arms when this fires. */
const MAX_TIMER_MS = 2_147_483_647;

/** One timer for the next owner-certificate expiry. */
export function createOwnerExpiryTimer(params: { onExpired: () => Promise<void> }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    /** Schedules `onExpired` at `atSeconds` (unix seconds), replacing any earlier schedule. */
    arm(atSeconds: number | undefined): void {
      stop();
      if (atSeconds === undefined) {
        return;
      }
      const delay = Math.min(MAX_TIMER_MS, Math.max(0, atSeconds * 1000 - Date.now()));
      timer = setTimeout(() => {
        timer = undefined;
        void params.onExpired();
      }, delay);
      timer.unref?.();
    },
    stop,
  };
}
