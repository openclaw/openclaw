const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;

type SessionEventRefreshCoordinatorOptions = {
  active: boolean;
  refresh: (isCurrent: () => boolean) => Promise<void>;
};

/** Canonical bounded event refresh policy shared by session-list owners. */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let deadline = 0;
  let nextAllowed = 0;
  let pending: object | null = null;
  let revision = 0;
  // Hidden pages and in-flight requests retain one trailing invalidation.
  let queued = false;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = 0;
    deadline = 0;
  };

  const arm = (debounce = true) => {
    if (!active || pending || !queued) {
      return;
    }
    const now = Date.now();
    deadline ||= now + SESSION_EVENT_REFRESH_MAX_WAIT_MS;
    clearTimeout(timer);
    const delay = debounce ? Math.min(SESSION_EVENT_REFRESH_DEBOUNCE_MS, deadline - now) : 0;
    timer = setTimeout(start, Math.max(delay, nextAllowed - now));
  };

  const start = () => {
    clearTimer();
    if (!active || pending || !queued) {
      return;
    }
    queued = false;
    const request = {};
    pending = request;
    const started = Date.now();
    const requestRevision = revision;
    void refresh(() => pending === request && requestRevision === revision)
      .catch(() => {})
      .finally(() => {
        if (pending !== request) {
          return;
        }
        pending = null;
        const completed = Date.now();
        nextAllowed = completed + Math.min(15_000, Math.max(1_000, 3 * (completed - started)));
        arm();
      });
  };

  const absorb = () => {
    revision += 1;
    clearTimer();
    queued = false;
  };
  const reset = () => {
    absorb();
    pending = null;
    nextAllowed = 0;
  };

  return {
    schedule() {
      queued = true;
      arm();
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        arm(false);
        return;
      }
      queued ||= markDirty || timer !== 0;
      clearTimer();
    },
    absorb,
    reset,
    dispose: reset,
  };
}
