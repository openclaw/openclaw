import { AsyncLocalStorage } from "node:async_hooks";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-coordinator.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-cache.js";
import type { RetainedReadScope } from "./openclaw-state-read.types.js";

/** Normal drainage and explicit abort retain the selected callback's context. */
export function bindRetainedReadScope(scope: RetainedReadScope) {
  const context = scope.work.run(() => AsyncLocalStorage.snapshot());
  return {
    run: <T>(operation: () => Promise<T>): Promise<T> =>
      context(() => runRetainedReadScope(scope, () => scope.work.track(operation))),
    abort: (reason: unknown) => context(() => scope.work.beginClose(reason)),
  };
}

/** Closing retains custody for accepted readers, but never admits a new reader. */
export function assertRetainedReadScopeAdmission(
  pathname: string,
  scopes: readonly (RetainedReadScope | undefined)[],
): void {
  if (scopes.some((scope) => scope?.path === pathname && (!scope.active || scope.work.isClosing))) {
    throw new StateDatabaseReadAdmissionInvalidatedError(
      "Shared-state read scope is closing or closed; retry the operation in a current scope.",
    );
  }
}

export function createRetainedReadScope(
  pathname: string,
  identity: DatabasePathIdentity,
  cleanup?: () => Promise<void>,
): RetainedReadScope {
  let pending: Promise<void> | undefined;
  let unregister: (() => void) | undefined;
  const scope: RetainedReadScope = {
    path: pathname,
    active: true,
    work: new AsyncWorkScope(),
    resources: new Set(),
    close() {
      if (!scope.active) {
        return Promise.resolve();
      }
      // The callback owns its private copy until settlement, even if live writers close.
      unregister ??= registerOpenClawStateDatabaseAsyncResource({
        async close(current) {
          if (
            !current ||
            current.key === identity.key ||
            current.canonicalPath === identity.canonicalPath
          ) {
            await scope.close();
          }
        },
      });
      return (pending ??= (async () => {
        await scope.work.drain();
        const settled = await Promise.allSettled(
          [...scope.resources].map((resource) => resource.close()),
        );
        throwSqliteLifecycleErrors(
          settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          "Shared-state read scope drainage failed",
        );
        await cleanup?.();
        scope.active = false;
        unregister?.();
      })().finally(() => {
        pending = undefined;
      }));
    },
  };
  return scope;
}

export async function runRetainedReadScope<T>(
  scope: RetainedReadScope,
  operation: () => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { error: unknown };
  const errors: unknown[] = [];
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
    errors.push(error);
  }
  try {
    await scope.close();
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Shared-state read scope and cleanup failed");
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
