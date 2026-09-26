import { SqliteWorkerError, isSqliteWorkerStoreAvailable } from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawDatabaseMaintenanceResource } from "./openclaw-state-db-async-lifecycle.js";
import { getOpenClawStateDatabaseTerminalFailureAsync } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { hydrateOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import {
  runWithCapturedWorkerContext,
  runWithOpenClawStateWorkerStore,
} from "./openclaw-state-worker-operation.js";
import type { DomainScope, Store } from "./openclaw-state-worker-store.types.js";

export type OpenClawStateWorkerLease = DomainScope & {
  readonly ready: Promise<void>;
  runOperation<T>(operation: (scope: DomainScope) => Promise<T>): Promise<T>;
  release(): Promise<void>;
  retire(): Promise<void>;
};
/** Retain a logical actor resource while tracking only acquisition and individual commands. */
export function retainOpenClawStateWorkerLease(
  context: OpenClawStateWorkerContext,
  owner: {
    open(context: OpenClawStateWorkerContext): Promise<Store | undefined>;
    retainOperation(store: Store): () => void | Promise<void>;
  },
  finalize?: (scope: DomainScope) => Promise<void>,
): OpenClawStateWorkerLease {
  const maintenance = context.maintenanceScope;
  context.admission.assertCurrent();
  maintenance?.assertAdmission();
  const ready = createDeferredCore();
  const admitted = createDeferredCore();
  const released = createDeferredCore();
  type Invocation = {
    phase: "accepting" | "draining" | "closed";
    pending: Set<Promise<unknown>>;
  };
  const invocations = new Set<Invocation>();
  const operations = new Set<Promise<unknown>>();
  let retained: Promise<void> | undefined;
  let releaseOperation: (() => void | Promise<void>) | undefined;
  let retirement: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let sealed = false;
  let invalidated = false;
  let store: Store | undefined;
  let scope: DomainScope | undefined;
  let acquisitionReady = false;
  void ready.promise.catch(() => undefined);

  const assertResourceCurrent = () => resource?.assertCurrent();
  const assertInvocation = (invocation: Invocation) => {
    if (invocation.phase === "closed" || invalidated) {
      throw new SqliteWorkerError("Shared-state worker operation is closed", "closed");
    }
    context.admission.assertCurrent();
    assertResourceCurrent();
  };
  const assertCommandAdmission = (invocation: Invocation) => {
    assertInvocation(invocation);
    if (invocation.phase !== "accepting") {
      throw new SqliteWorkerError("Shared-state worker operation is closed", "closed");
    }
  };
  const assertNewOperation = () => {
    if (sealed) {
      throw new SqliteWorkerError("Shared-state worker lease is closed", "closed");
    }
    context.admission.assertCurrent();
    maintenance?.assertAdmission();
  };
  const retireNative = () => {
    retirement ??= (async () => {
      await admitted.promise.catch(() => undefined);
      released.resolve();
      const errors: unknown[] = [];
      try {
        await retained;
      } catch (error) {
        errors.push(error);
      }
      try {
        await releaseOperation?.();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Shared-state worker lease retirement failed", {
          cause: errors[0],
        });
      }
    })();
    void retirement.catch(() => undefined);
    return retirement;
  };
  const retire = () => {
    sealed = true;
    invalidated = true;
    for (const invocation of invocations) {
      invocation.phase = "closed";
    }
    // Invalidation joins dispatched native commands, not external body readers.
    return retireNative();
  };
  const createOperationScope = (invocation: Invocation): DomainScope => ({
    execute: (command, options) => {
      try {
        assertCommandAdmission(invocation);
      } catch (error) {
        const rejected = createDeferredCore<never>();
        rejected.reject(error);
        void rejected.promise.catch(() => undefined);
        return rejected.promise;
      }
      const run = async () => {
        // Prepared input transfers its credits at enqueue in this same turn.
        if (!acquisitionReady) {
          await ready.promise;
        }
        assertInvocation(invocation);
        if (!scope) {
          throw new SqliteWorkerError("Shared-state worker lease is not ready", "closed");
        }
        return scope.execute(command, options);
      };
      const operation = resource ? resource.run(run) : run();
      const result = operation.catch(async (error: unknown) => {
        // A finalizer may already be draining this command. It owns retirement
        // then; awaiting its close here would make the command wait on itself.
        if (store && !sealed && !isSqliteWorkerStoreAvailable(store)) {
          try {
            await retire();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Shared-state operation and retirement failed",
              { cause: cleanupError },
            );
          }
        }
        throw error;
      });
      invocation.pending.add(result);
      const settled = () => invocation.pending.delete(result);
      void result.then(settled, settled);
      // Only this explicit, still-active invocation can continue after lexical
      // admission closes. Its finite commands remain in maintenance drainage.
      return maintenance ? maintenance.track(result) : result;
    },
  });
  const runOperation = <T>(operation: (scope: DomainScope) => Promise<T>): Promise<T> => {
    try {
      assertNewOperation();
    } catch (error) {
      const rejected = createDeferredCore<T>();
      rejected.reject(error);
      void rejected.promise.catch(() => undefined);
      return rejected.promise;
    }
    const invocation: Invocation = { phase: "accepting", pending: new Set() };
    invocations.add(invocation);
    const completion = createDeferredCore<T>();
    operations.add(completion.promise);
    void completion.promise.catch(() => undefined);
    const run = async () => {
      try {
        // Invoke immediately so the owner can capture admission before any await.
        return await operation(createOperationScope(invocation));
      } finally {
        // Stop new submissions while accepted commands finish cold acquisition.
        if (invocation.phase === "accepting") {
          invocation.phase = "draining";
        }
        await Promise.allSettled(invocation.pending);
        invocation.phase = "closed";
        invocations.delete(invocation);
      }
    };
    void run().then(
      (value) => {
        operations.delete(completion.promise);
        completion.resolve(value);
      },
      (error: unknown) => {
        operations.delete(completion.promise);
        completion.reject(error);
      },
    );
    return completion.promise;
  };
  const release = () => {
    if (invalidated) {
      return retireNative();
    }
    if (closing) {
      return closing;
    }
    sealed = true;
    closing = (async () => {
      const errors: unknown[] = [];
      const terminal: Invocation = { phase: "accepting", pending: new Set() };
      invocations.add(terminal);
      try {
        await ready.promise;
        await finalize?.(createOperationScope(terminal));
      } catch (error) {
        errors.push(error);
      } finally {
        if (terminal.phase === "accepting") {
          terminal.phase = "draining";
        }
        await Promise.allSettled(terminal.pending);
        terminal.phase = "closed";
        invocations.delete(terminal);
      }
      const results = await Promise.allSettled(operations);
      errors.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      try {
        await retireNative();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Shared-state worker lease cleanup failed", {
          cause: errors[0],
        });
      }
    })();
    void closing.catch(() => undefined);
    return closing;
  };
  const lease: OpenClawStateWorkerLease = {
    ready: ready.promise,
    execute: (command, options) =>
      runOperation((operationScope) => operationScope.execute(command, options)),
    runOperation,
    release,
    retire,
  };
  maintenance?.own(lease, "shared-resources", release);
  const resource = maintenance
    ? captureOpenClawDatabaseMaintenanceResource(lease, maintenance)
    : undefined;
  const acquire = async () => {
    try {
      const failure = await getOpenClawStateDatabaseTerminalFailureAsync(context);
      if (failure) {
        throw failure;
      }
      context.admission.assertCurrent();
      store = await owner.open(context);
      context.admission.assertCurrent();
      if (!store) {
        throw new Error("Canonical shared-state worker did not open its database");
      }
      releaseOperation = owner.retainOperation(store);
      // The client scope retains native custody as a resource, never as pending
      // maintenance work that must finish before the resource phase can begin.
      retained = runWithOpenClawStateWorkerStore(
        store,
        context,
        async (operationScope) => {
          scope = operationScope;
          admitted.resolve();
          await released.promise;
        },
        assertResourceCurrent,
      );
      void retained.catch(admitted.reject);
      await admitted.promise;
      context.admission.assertCurrent();
      if (invalidated) {
        throw new SqliteWorkerError("Shared-state worker lease is closed", "closed");
      }
    } catch (error) {
      const failure = error instanceof Error ? hydrateOpenClawStateWorkerError(error) : error;
      admitted.reject(failure);
      try {
        await retire();
      } catch (cleanupError) {
        if (cleanupError !== failure) {
          throw new AggregateError(
            [failure, cleanupError],
            "Shared-state lease acquisition failed",
            {
              cause: cleanupError,
            },
          );
        }
      }
      throw failure;
    }
  };
  const acquisition = runWithCapturedWorkerContext(context, acquire);
  void acquisition.then(() => {
    acquisitionReady = true;
    ready.resolve();
  }, ready.reject);
  return lease;
}
