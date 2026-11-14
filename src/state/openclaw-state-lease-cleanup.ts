import { isStateDatabaseMaintenanceContention } from "../infra/gateway-state-owner-record.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { OpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const CONTENDED_CLEANUP_RETRY_INITIAL_MS = 250;
const CONTENDED_CLEANUP_RETRY_MAX_MS = 5_000;

/** Keep unfinished lease disposal with its original resource owner. */
export function createOpenClawStateLeaseCleanup(params: {
  maintenanceScope?: OpenClawDatabaseMaintenanceScope;
  context?: OpenClawStateWorkerContext;
  nativeIdentity?(): DatabasePathIdentity | undefined;
  revoke(): void;
  finish(): Promise<void>;
  /** Epoch ms after which the stored lease no longer blocks other owners. */
  retryDeadline?(): number | undefined;
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
  let databaseIdentity = params.context?.admission.identity;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (): Promise<void> => {
    if (complete) {
      return Promise.resolve();
    }
    return (attempt ??= Promise.resolve()
      .then(() => params.finish())
      .then(() => {
        complete = true;
        clearTimeout(retryTimer);
        unregister?.();
      })
      .catch((error: unknown) => {
        attempt = undefined;
        throw error;
      }));
  };
  // Another process's offline maintenance is brief; an unreleased lease would otherwise
  // block every later acquirer, including this process, until its stored expiry.
  // finish() is idempotent, and release still targets only this owner's lease row.
  const retryContendedCleanup = (error: unknown, retries: number) => {
    const deadline = params.retryDeadline?.();
    if (
      complete ||
      deadline === undefined ||
      Date.now() >= deadline ||
      !isStateDatabaseMaintenanceContention(error)
    ) {
      return;
    }
    const delayMs = Math.min(
      CONTENDED_CLEANUP_RETRY_MAX_MS,
      CONTENDED_CLEANUP_RETRY_INITIAL_MS * 2 ** retries,
    );
    clearTimeout(retryTimer);
    retryTimer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        retryTimer = undefined;
        finish().catch((next: unknown) => retryContendedCleanup(next, retries + 1));
      }, delayMs),
    );
    retryTimer.unref?.();
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
        if (!unregister) {
          // Native callbacks may close shared state themselves. Retain only their settled cleanup.
          databaseIdentity = params.nativeIdentity?.();
          if (databaseIdentity) {
            unregister = registerOpenClawStateDatabaseAsyncResource(resource);
          }
        }
        try {
          await finish();
        } catch (cleanupError) {
          retryContendedCleanup(cleanupError, 0);
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
