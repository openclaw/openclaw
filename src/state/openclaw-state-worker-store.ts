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
  OpenClawStateWorkerInspectionOperations,
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

/** Retired cleanup uses the retained owner's backend without renewing read admission. */
export function openOpenClawStateWorkerCleanupStore(
  databasePath: string,
  context: SqliteWorkerStateContext,
  assertOwned: () => void,
) {
  return owner().openCleanup(databasePath, context, assertOwned);
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
  return runWithCapturedWorkerContext(context, () =>
    runAdmittedOpenClawStateWorkerOperation(context, operation, options),
  );
}

async function runAdmittedOpenClawStateWorkerOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
  options?: OperationOptions,
): Promise<T | undefined> {
  try {
    context.admission.assertCurrent();
    options?.assertCurrent?.();
    const failure = await getOpenClawStateDatabaseTerminalFailureAsync(context);
    if (failure) {
      throw failure;
    }
    context.admission.assertCurrent();
    options?.assertCurrent?.();
    const store = await owner().open(context, options);
    context.admission.assertCurrent();
    if (!store) {
      if (options?.existingOnly) {
        return undefined;
      }
      throw new Error("Canonical shared-state worker did not open its database");
    }
    const releaseOperation = owner().retainOperation(store);
    try {
      context.admission.assertCurrent();
      options?.assertCurrent?.();
      return await runWithOpenClawStateWorkerStore(
        store,
        context,
        operation,
        options?.assertCurrent,
        options?.createAdmission,
        options?.requireStateLifecycle ?? false,
      );
    } finally {
      // The owner observes retirement; other clients may await this operation's result.
      void releaseOperation();
    }
  } catch (error) {
    if (error instanceof Error) {
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
    throw error;
  }
}

/** Inspect the existing file without recursively admitting a domain operation. */
export async function inspectOpenClawStateDatabase(
  context: OpenClawStateWorkerContext,
  command: {
    type: "database.generationMatches";
    input: OpenClawStateWorkerInspectionOperations["database.generationMatches"]["input"];
  },
): Promise<boolean | undefined> {
  return runWithCapturedWorkerContext(context, () =>
    inspectAdmittedOpenClawStateDatabase(context, command),
  );
}

async function inspectAdmittedOpenClawStateDatabase(
  context: OpenClawStateWorkerContext,
  command: {
    type: "database.generationMatches";
    input: OpenClawStateWorkerInspectionOperations["database.generationMatches"]["input"];
  },
): Promise<boolean | undefined> {
  try {
    const store = await owner().open(context, { existingOnly: true });
    context.admission.assertCurrent();
    if (!store) {
      return undefined;
    }
    const releaseOperation = owner().retainOperation(store);
    try {
      context.admission.assertCurrent();
      return await runWithOpenClawStateWorkerStore(store, context, (scope) =>
        scope.execute(command),
      );
    } finally {
      void releaseOperation();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw hydrateOpenClawStateWorkerError(error);
    }
    throw error;
  }
}
