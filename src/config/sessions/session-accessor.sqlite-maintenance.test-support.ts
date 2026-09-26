import { onTestFinished, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";

/** Row changes precede archive publication; join the owner's complete finalization. */
export function observeSessionMaintenanceCompletion(databasePath: string) {
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
  const observer = vi
    .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
    .mockImplementation((scope, ...args) => {
      const result = finalize(scope, ...args);
      if (scope.path === databasePath) {
        completed.resolve(result);
      }
      return result;
    });
  onTestFinished(() => observer.mockRestore());
  return completed.promise;
}

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
