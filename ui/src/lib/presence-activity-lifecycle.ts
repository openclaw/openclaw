import {
  PRESENCE_ACTIVE_WINDOW_MS,
  presenceViewerLastActivity,
  type PresenceViewer,
} from "./presence-users.ts";

/** Refreshes presentation at interaction expiry, without network polling. */
export function createPresenceActivityLifecycle(
  viewers: () => readonly PresenceViewer[],
  refresh: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  let connected = false;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    deadline = undefined;
  };
  // Call before rendering: an expiry during render must still have a scheduled wakeup.
  const sync = () => {
    const now = Date.now();
    const deadlines =
      connected && document.visibilityState !== "hidden"
        ? viewers().flatMap((user) => {
            const activity = presenceViewerLastActivity(user);
            const at = activity === undefined ? undefined : activity + PRESENCE_ACTIVE_WINDOW_MS;
            return at !== undefined && at > now ? [at] : [];
          })
        : [];
    const next = deadlines.length ? Math.min(...deadlines) : undefined;
    if (next === deadline) {
      return;
    }
    clear();
    if (next !== undefined) {
      deadline = next;
      timer = setTimeout(tick, next - now);
    }
  };
  const tick = () => {
    clear();
    refresh();
    sync();
  };
  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") {
      clear();
    } else {
      tick();
    }
  };
  return {
    sync,
    connect() {
      connected = true;
      document.addEventListener("visibilitychange", visibilityChanged);
      tick();
    },
    disconnect() {
      connected = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      clear();
    },
  };
}
