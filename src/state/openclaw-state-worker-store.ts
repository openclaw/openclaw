import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  getOpenClawStateDatabaseTerminalFailureAsync,
  recordOpenClawStateDatabaseOpenFailure,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { findOpenClawStateDatabaseFailure } from "./openclaw-state-db-failure.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerOperationOptions as OperationOptions,
} from "./openclaw-state-worker-contract.js";
import { hydrateOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import {
  retainOpenClawStateWorkerLease,
  type OpenClawStateWorkerLease,
} from "./openclaw-state-worker-lease.js";
import {
  runWithCapturedWorkerContext,
  runWithOpenClawStateWorkerStore,
} from "./openclaw-state-worker-operation.js";
import { getOpenClawStateWorkerOwner as owner } from "./openclaw-state-worker-owner.js";
import type { DomainScope } from "./openclaw-state-worker-store.types.js";

export type { OpenClawStateWorkerLease } from "./openclaw-state-worker-lease.js";

/** Prepare only code for a shared-state operation after the next database drain. */
export function prepareOpenClawStateWorkerRuntime() {
  return owner().prepareRuntime();
}

/** Retired cleanup uses the retained owner's backend without renewing read admission. */
export function openOpenClawStateWorkerCleanupStore(
  databasePath: string,
  context: SqliteWorkerStateContext,
  assertOwned: () => void,
  identity: DatabasePathIdentity,
) {
  return owner().openCleanup(databasePath, context, assertOwned, identity);
}

export async function executeOpenClawStateWorker<Key extends keyof OpenClawStateWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  const result = await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
  context.admission.assertCurrent();
  return result;
}

/** Retain the canonical actor for capture callbacks and their terminal writes. */
export function createOpenClawStateWorkerLease(
  context: OpenClawStateWorkerContext,
  finalize?: (scope: DomainScope) => Promise<void>,
): OpenClawStateWorkerLease {
  return retainOpenClawStateWorkerLease(
    context,
    {
      open: (captured) => owner().open(captured),
      retainOperation: (store) => owner().retainOperation(store),
    },
    finalize,
  );
}

/** Retain the actor through its durable result and main-process reconciliation. */
export function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: OperationOptions & { existingOnly?: false },
): Promise<T>;
export function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options: OperationOptions & { existingOnly: boolean },
): Promise<T | undefined>;
export async function runOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: OperationOptions,
): Promise<T | undefined> {
  return runWithCapturedWorkerContext(context, async () => {
    try {
      options?.signal?.throwIfAborted();
      context.admission.assertCurrent();
      options?.assertCurrent?.();
      const failure = await getOpenClawStateDatabaseTerminalFailureAsync(context, options?.signal);
      if (failure) {
        throw failure;
      }
      context.admission.assertCurrent();
      options?.assertCurrent?.();
      const store = await owner().open(context, options);
      if (!store) {
        options?.signal?.throwIfAborted();
        context.admission.assertCurrent();
        if (options?.existingOnly) {
          return undefined;
        }
        throw new Error("Canonical shared-state worker did not open its database");
      }
      const releaseOperation = owner().retainOperation(store);
      try {
        options?.signal?.throwIfAborted();
        context.admission.assertCurrent();
        options?.assertCurrent?.();
        return await runWithOpenClawStateWorkerStore(
          store,
          context,
          operation,
          options?.assertCurrent,
          options?.createAdmission,
          options?.signal,
        );
      } finally {
        // The owner observes retirement; other clients may await this operation's result.
        void releaseOperation();
      }
    } catch (error) {
      const hydrated = hydrateOpenClawStateWorkerError(error);
      const failure = findOpenClawStateDatabaseFailure(hydrated, context.admission.databasePath);
      if (
        failure &&
        !openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(
          context.admission.databasePath,
        )
      ) {
        try {
          context.admission.assertCurrent();
        } catch {
          // A retired generation cannot publish a refusal against its replacement.
          throw hydrated;
        }
        recordOpenClawStateDatabaseOpenFailure(context.admission.databasePath, failure);
      }
      throw hydrated;
    }
  });
}
