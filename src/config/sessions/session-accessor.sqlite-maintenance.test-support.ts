import { onTestFinished } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";

/** Observe committed maintenance rows without imposing a worker-startup deadline. */
export function observeSessionMaintenanceChanges(databasePath: string, ...sessionKeys: string[]) {
  const pending = new Set(sessionKeys);
  const completed = createDeferredCore();
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (!("sessionKey" in change) || change.storePath !== databasePath) {
      return;
    }
    if (pending.delete(change.sessionKey) && pending.size === 0) {
      unsubscribe();
      completed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  return completed.promise;
}
