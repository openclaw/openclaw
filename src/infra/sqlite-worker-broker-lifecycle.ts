import { createDeferredCore } from "../shared/deferred.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-coordinator.js";
import { releaseSqliteWorkerActorCoordinators } from "./sqlite-worker-broker-admission.js";
import type { Actor, EnqueueOptions, Slot, StoreClient } from "./sqlite-worker-broker.types.js";

/** The broker retains these maps; this owner drains clients before native close custody. */
export function createSqliteWorkerLifecycle({
  actors,
  stores,
  enqueueClose,
  fail,
}: {
  actors: Map<string, Actor>;
  stores: Map<object, StoreClient>;
  enqueueClose: (
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ) => Promise<unknown>;
  fail: (slot: Slot, error: unknown) => void;
}) {
  function releaseActorReference(actor: Actor): void {
    actor.references -= 1;
    if (!actor.references) {
      actor.onReferencesDrained?.();
    }
  }

  async function rejectSlotAdmission(slot: Slot, error: unknown): Promise<never> {
    slot.pendingOpens -= 1;
    try {
      await retireEmpty(slot);
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "SQLite slot admission and cleanup failed",
        error,
      );
    }
    throw error;
  }

  function retireActor(identity: object): Promise<void> {
    const actor = [...actors.values()].find((entry) => entry === identity);
    if (!actor) {
      return Promise.resolve();
    }
    if (actor.retirement) {
      return actor.retirement;
    }
    actor.retirementRequested = true;
    const drained = createDeferredCore();
    actor.onReferencesDrained = drained.resolve;
    if (!actor.references) {
      drained.resolve();
    }
    const clients = [...stores.values()].filter((client) => client.actor === actor);
    // Seal every client synchronously, then drain accepted scopes before native close custody.
    actor.retirement = (async () => {
      const results = await Promise.allSettled(clients.map((client) => client.close()));
      await drained.promise;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (!errors.length) {
        try {
          await closeActor(actor);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "SQLite actor retirement failed", { cause: errors[0] });
      }
    })().finally(() => {
      actor.retirement = undefined;
      actor.onReferencesDrained = undefined;
    });
    return actor.retirement;
  }

  function closeActor(
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ): Promise<void> {
    if (actor.cleanupState === "complete") {
      return Promise.resolve();
    }
    if (actor.closing) {
      return actor.closing;
    }
    const firstAttempt = actor.cleanupState === undefined;
    actor.cleanupState = "pending";
    actor.closing = (async () => {
      const errors: unknown[] = [];
      if (!actor.backendClosed) {
        try {
          await enqueueClose(actor, maintenanceScope);
          actor.backendClosed = true;
        } catch (error) {
          errors.push(error);
          fail(actor.slot, error instanceof Error ? error : new Error(String(error)));
          await actor.slot.exit;
        }
      } else if (firstAttempt && actor.slot.failed && !actor.slot.retiredAfterCompletion) {
        errors.push(actor.slot.failed);
      }
      try {
        if (
          process.versions.bun ||
          actor.slot.failed ||
          (!actor.slot.pendingOpens && [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Bun retains native statements after close; keep pathname ownership until VM exit.
          await retire(actor.slot);
        } else {
          releaseSqliteWorkerActorCoordinators(actor);
        }
      } catch (error) {
        errors.push(error);
      } finally {
        forget(actor);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite worker actor cleanup failed", {
          cause: errors[0],
        });
      }
    })().finally(() => {
      actor.closing = undefined;
    });
    return actor.closing;
  }

  function forget(actor: Actor): void {
    if (actor.gatewaySchemaFence || actor.pendingStateLifecycles.size) {
      actor.cleanupState = "pending";
      return;
    }
    if (actors.get(actor.key) === actor) {
      actors.delete(actor.key);
    }
    actor.slot.actors.delete(actor);
    actor.cleanupState = "complete";
  }

  async function retireEmpty(slot: Slot): Promise<void> {
    if (!slot.actors.size && !slot.pendingOpens) {
      await retire(slot);
    }
  }

  function retire(slot: Slot): Promise<void> {
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

  return {
    releaseActorReference,
    rejectSlotAdmission,
    retireActor,
    closeActor,
    forget,
    retireEmpty,
    retire,
  };
}
