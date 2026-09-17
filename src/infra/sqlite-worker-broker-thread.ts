import type { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import {
  releaseSqliteWorkerActorCoordinators,
  resolveSqliteWorkerModuleUrl,
} from "./sqlite-worker-broker-admission.js";
import { withSqliteWorkerCleanupFailure } from "./sqlite-worker-broker-reply.js";
import type {
  PreparedSqliteWorkerOpen,
  Slot,
  SqliteWorkerThreadScope,
} from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

/** Placement only: each store still owns its separate native connection and close. */
export async function runSqliteWorkerThreadReservation<T>(
  moduleUrl: URL,
  operation: () => Promise<T>,
  {
    threadScopes,
    operations,
    isDraining,
    retireEmpty,
  }: {
    threadScopes: AsyncLocalStorage<SqliteWorkerThreadScope>;
    operations: Set<Promise<void>>;
    isDraining: () => boolean;
    retireEmpty: (slot: Slot) => Promise<void>;
  },
): Promise<T> {
  if (process.versions.bun) {
    return operation();
  }
  if (isDraining()) {
    throw new SqliteWorkerError("SQLite worker host is closing", "closed");
  }
  // Admission belongs to drain before module resolution can yield.
  const released = createDeferredCore();
  operations.add(released.promise);
  let scope: SqliteWorkerThreadScope | undefined;
  try {
    const backend = await resolveSqliteWorkerModuleUrl(moduleUrl);
    if (isDraining()) {
      throw new SqliteWorkerError("SQLite worker host is closing", "closed");
    }
    for (let parent = threadScopes.getStore(); parent; parent = parent.parent) {
      if (parent.moduleUrl === backend.moduleUrl) {
        if (!parent.active || parent.failure) {
          throw (
            parent.failure ??
            new SqliteWorkerError("SQLite worker thread scope is closed", "closed")
          );
        }
        return await operation();
      }
    }
    scope = {
      moduleUrl: backend.moduleUrl,
      active: true,
      placement: true,
      pending: new Set(),
      parent: threadScopes.getStore(),
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await threadScopes.run(scope, operation) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    scope.active = false;
    await Promise.allSettled(scope.pending);
    const slot = scope.slot;
    if (slot) {
      withdrawSqliteWorkerThreadReservation(slot);
      try {
        await retireEmpty(slot);
      } catch (error) {
        if (!outcome.ok) {
          throw withSqliteWorkerCleanupFailure(
            toErrorObject(outcome.error, "SQLite worker thread callback failed"),
            error,
          );
        }
        throw error;
      }
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    if (scope) {
      scope.active = false;
    }
    operations.delete(released.promise);
    released.resolve();
  }
}

export function withdrawSqliteWorkerThreadReservation(slot: Slot): void {
  const scope = slot.threadScope;
  if (scope) {
    scope.placement = false;
    scope.slot = undefined;
    slot.threadScope = undefined;
  }
}

export function captureSqliteWorkerThreadScopes(
  scope: SqliteWorkerThreadScope | undefined,
): NonNullable<PreparedSqliteWorkerOpen["threadScopes"]> {
  const captured: NonNullable<PreparedSqliteWorkerOpen["threadScopes"]> = [];
  for (let current = scope; current; current = current.parent) {
    captured.push({ scope: current, active: current.active });
  }
  return captured;
}

export function retainSqliteWorkerThreadOpening(
  scopes: PreparedSqliteWorkerOpen["threadScopes"],
  opening: Promise<unknown>,
): void {
  for (const { scope, active } of scopes ?? []) {
    if (active) {
      scope.pending.add(opening);
      void opening.then(
        () => scope.pending.delete(opening),
        () => scope.pending.delete(opening),
      );
    }
  }
}

export function retireSqliteWorkerSlot(slot: Slot): Promise<void> {
  slot.retiring ??= (async () => {
    const errors: unknown[] = [];
    if (!slot.exited) {
      try {
        await slot.worker.terminate();
      } catch (error) {
        errors.push(error);
      }
    }
    await slot.exit;
    for (const actor of slot.actors) {
      try {
        releaseSqliteWorkerActorCoordinators(actor);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "SQLite worker retirement cleanup failed", {
        cause: errors[0],
      });
    }
  })().finally(() => {
    slot.retiring = undefined;
  });
  return slot.retiring;
}
