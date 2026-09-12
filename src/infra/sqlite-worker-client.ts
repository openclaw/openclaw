import { isPromise } from "node:util/types";
import { serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import type { OperationScope, StoreClient } from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

export function runSqliteWorkerClientOperation<Operations extends SqliteWorkerOperations, T>(
  client: StoreClient,
  operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
  stateContext: SqliteWorkerStateContext | undefined,
  track: (pending: Promise<void>) => () => void,
  assertCurrent?: (commandType: PropertyKey) => void,
): Promise<T> {
  const scope: OperationScope = {
    assertCurrent,
    active: true,
    pending: new Set(),
    ...(stateContext
      ? {
          stateContext: {
            environment: { ...stateContext.environment },
            coordinatorRuntime: { ...stateContext.coordinatorRuntime },
          },
        }
      : {}),
  };
  const released = createDeferredCore();
  client.scopes.add(released.promise);
  const untrack = track(released.promise);
  return (async () => {
    try {
      const result = operation({
        execute: (command, options = {}) =>
          // SAFETY: The exact admitted store retains its typed backend.
          client.execute(command, options, scope) as Promise<
            Operations[typeof command.type]["output"]
          >,
      });
      return isPromise(result) ? await result : result;
    } finally {
      scope.active = false;
      // A callback can throw after dispatch or leave a command unawaited.
      await Promise.allSettled(scope.pending);
      client.scopes.delete(released.promise);
      untrack();
      released.resolve();
    }
  })();
}

export function createSqliteWorkerClient<Operations extends SqliteWorkerOperations>(owner: {
  isDraining: () => boolean;
  isAvailable: () => boolean;
  dispatch: (
    payload: Buffer,
    signal: AbortSignal | undefined,
    scope: OperationScope | undefined,
    assertCurrent: (() => void) | undefined,
  ) => Promise<unknown>;
  release: () => Promise<void>;
}) {
  let closed: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const client: StoreClient = {
    sealed: owner.isDraining(),
    isAvailable: owner.isAvailable,
    scopes: new Set(),
    execute: (command, options, scope) => {
      if (scope ? !scope.active : closed || client.sealed || owner.isDraining()) {
        return Promise.reject(new SqliteWorkerError("SQLite worker store is closed", "closed"));
      }
      if (options.signal?.aborted) {
        return Promise.reject(
          toErrorObject(options.signal.reason, "SQLite worker operation canceled"),
        );
      }
      let payload: Buffer;
      let assertCurrent: (() => void) | undefined;
      try {
        const commandType = command.type;
        const admission = scope?.assertCurrent;
        assertCurrent = admission ? () => admission(commandType) : undefined;
        assertCurrent?.();
        // The queued guard and wire command must observe the same captured type.
        payload = serialize({ type: commandType, input: command.input });
      } catch (error) {
        return Promise.reject(
          toErrorObject(error, "SQLite worker command could not be serialized"),
        );
      }
      const operation = owner.dispatch(payload, options.signal, scope, assertCurrent);
      pending.add(operation);
      scope?.pending.add(operation);
      void operation.then(
        () => {
          pending.delete(operation);
          scope?.pending.delete(operation);
        },
        () => {
          pending.delete(operation);
          scope?.pending.delete(operation);
        },
      );
      return operation;
    },
  };
  const store: SqliteWorkerStore<Operations> = {
    execute: (command, options = {}) =>
      // SAFETY: The typed backend owns this result.
      client.execute(command, options) as Promise<Operations[typeof command.type]["output"]>,
    close: () => {
      if (!closed) {
        client.sealed = true;
        closed = (async () => {
          await Promise.allSettled(client.scopes);
          await Promise.allSettled(pending);
          await owner.release();
        })().catch((error: unknown) => {
          closed = undefined;
          throw error;
        });
      }
      return closed;
    },
  };
  return { store, client };
}
