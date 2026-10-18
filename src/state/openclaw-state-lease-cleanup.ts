import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** Keep unfinished lease disposal with its original resource owner. */
export function createOpenClawStateLeaseCleanup(params: {
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  context?: OpenClawStateWorkerContext;
  revoke(): void;
  finish(): Promise<void>;
  workerOwner():
    | {
        drain(): Promise<void>;
        rethrowIfUncertain(failure: unknown, authorityError: unknown): void;
      }
    | undefined;
}) {
  const operationSettled = createDeferredCore();
  let complete = false;
  let attempt: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  const databaseIdentity = params.context?.admission.identity;
  const finish = (): Promise<void> => {
    if (complete) {
      return Promise.resolve();
    }
    return (attempt ??= Promise.resolve()
      .then(() => params.finish())
      .then(() => {
        complete = true;
        unregister?.();
      })
      .catch((error: unknown) => {
        attempt = undefined;
        throw error;
      }));
  };
  const resource = {
    async close(identity?: DatabasePathIdentity): Promise<void> {
      if (
        complete ||
        (identity &&
          databaseIdentity?.key !== identity.key &&
          databaseIdentity?.canonicalPath !== identity.canonicalPath)
      ) {
        return;
      }
      params.revoke();
      await operationSettled.promise;
      await finish();
    },
  };
  params.maintenanceScope?.own(resource, "shared-leases", () => resource.close());
  // Async leases are admitted resources before their first open. Registration
  // after a failure could miss an already-snapshotted canonical close.
  if (params.context) {
    unregister = registerOpenClawStateDatabaseAsyncResource(resource);
  }
  return {
    async run<T>(operation: () => Promise<T>, prepareCleanup: () => void): Promise<T> {
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await operation() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        const workerOwner = params.workerOwner();
        prepareCleanup();
        try {
          await finish();
        } catch (cleanupError) {
          const combined =
            !outcome.ok && outcome.error !== cleanupError
              ? createSqliteLifecycleAggregateError(
                  [outcome.error, cleanupError],
                  "State lease operation and cleanup failed",
                  outcome.error,
                )
              : cleanupError;
          workerOwner?.rethrowIfUncertain(combined, undefined);
          throw combined;
        }
        if (outcome.ok) {
          await workerOwner?.drain();
        } else {
          workerOwner?.rethrowIfUncertain(outcome.error, undefined);
        }
      } finally {
        operationSettled.resolve();
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    },
  };
}
