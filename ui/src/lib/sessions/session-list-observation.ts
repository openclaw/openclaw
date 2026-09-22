import type { SessionConnectionOwner, SessionListSnapshot } from "./session-capability.ts";
import type { ManagedSessionList } from "./session-list-query.ts";

/** Own an observed query subscription and fence explicit refresh against disposal. */
export function observeManagedSessionList(
  entry: ManagedSessionList,
  listener: (snapshot: SessionListSnapshot) => void,
  subscribe: () => () => void,
  isCurrent: () => boolean,
  connectionOwner: SessionConnectionOwner,
  refresh: () => Promise<unknown>,
) {
  const unsubscribe = subscribe();
  let disposed = false;
  const check = () => {
    if (disposed || !isCurrent()) {
      throw new Error("This session query has been disposed.");
    }
  };
  try {
    listener(entry.snapshot);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    async refresh() {
      check();
      const connection = connectionOwner.capture();
      if (!connection) {
        throw new Error("The session query is unavailable while disconnected. Try again.");
      }
      await refresh();
      check();
      if (!connectionOwner.isCurrent(connection)) {
        throw new Error("The session query connection changed. Try again.");
      }
      if (entry.snapshot.error) {
        throw new Error(entry.snapshot.error);
      }
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        unsubscribe();
      }
    },
  };
}
