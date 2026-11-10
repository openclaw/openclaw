// Owner certificate expiry (OCF-278): an owner device whose certificate, or an
// ancestor in its chain, expires stops being admitted at that moment. Admission and
// owner auth check validity on every connection; this timer ends the sessions that
// were already open, at the earliest upcoming expiry.

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
