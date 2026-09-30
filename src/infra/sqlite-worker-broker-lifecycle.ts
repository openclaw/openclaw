import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import type { RuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "./sqlite-lifecycle-errors.js";
import {
  receiveSqliteWorkerReply,
  type SqliteWorkerReplyOwner,
} from "./sqlite-worker-broker-reply.js";
import type {
  Actor,
  EnqueueOptions,
  Slot,
  StoreClient,
  PreparedSqliteWorkerOpen,
} from "./sqlite-worker-broker.types.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

const runOutsideCaller = AsyncLocalStorage.snapshot();

/** The broker retains these maps; this owner drains clients before native close custody. */
export function createSqliteWorkerLifecycle({
  actors,
  slots,
  stores,
  enqueueClose,
  fail,
}: {
  actors: Map<string, Actor>;
  slots: Set<Slot>;
  stores: Map<object, StoreClient>;
  enqueueClose: (
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ) => Promise<unknown>;
  fail: (slot: Slot, error: unknown) => void;
}) {
  function createSlot(
    options: PreparedSqliteWorkerOpen,
    borrowedGenerationSlot: boolean,
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
  ): Slot {
    if (process.versions.bun && process.platform === "darwin") {
      ensureSqliteLibrarySelected();
    }
    options.assertCurrent?.();
    const worker = runOutsideCaller(() =>
      createCpuTrackedWorker(options.carrierUrl, {
        resourceLimits: { maxOldGenerationSizeMb: 512 },
        env: resolveNodeCompileCacheEnv(),
        execArgv: resolveRuntimeWorkerThreadExecArgv(options.carrierUrl),
      }),
    );
    const exited = createDeferredCore();
    const slot: Slot = {
      runtimeGeneration: options.runtimeGeneration,
      ...(borrowedGenerationSlot ? { borrowedGenerationSlot: true as const } : {}),
      worker,
      receiveReply: (reply) => receiveSqliteWorkerReply(slot, reply, replyOwner),
      actors: new Set(),
      queue: [],
      exit: exited.promise,
      exited: false,
      pendingOpens: 1,
    };
    const replyOwner = createReplyOwner(slot);
    slots.add(slot);
    worker.on("message", (reply: SqliteWorkerReply) => slot.receiveReply(reply));
    worker.on("error", (error) => fail(slot, error));
    worker.on("messageerror", (error) => fail(slot, error));
    worker.once("exit", (code) => {
      slot.exited = true;
      for (const actor of slot.actors) {
        actor.backendClosed = true;
        actor.markNativeStopped();
      }
      fail(slot, new Error(`SQLite worker exited with code ${code}`));
      slots.delete(slot);
      exited.resolve();
    });
    worker.unref();
    return slot;
  }

  async function settleGeneration(
    generation: RuntimeWorkerGeneration,
  ): Promise<() => Promise<void>> {
    const retained = [...actors.values()].filter((actor) => actor.runtimeGeneration === generation);
    const retirement = Promise.allSettled(retained.map((actor) => retireActor(actor)));
    await Promise.all(retained.map(async (actor) => await actor.settlement));
    return async () => {
      const results = await retirement;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      throwSqliteLifecycleErrors(errors, "Retained SQLite worker cleanup failed");
      await Promise.all(
        [...slots]
          .filter((slot) => slot.runtimeGeneration === generation)
          .map((slot) => retireEmpty(slot)),
      );
    };
  }

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
    // References drop only after accepted scopes and commands finish, independently
    // of a client close that may already be waiting on native termination.
    // Failed commands keep their references until the worker actually exits.
    actor.settlement = drained.promise;
    const clients = [...stores.values()].filter((client) => client.actor === actor);
    // Seal every client synchronously, then drain accepted scopes before native close custody.
    actor.retirement = (async () => {
      const results = await Promise.allSettled(clients.map((client) => client.close()));
      await actor.settlement;
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
    actor.cleanupState = "pending";
    actor.closing = (async () => {
      const errors: unknown[] = [];
      if (!actor.backendClosed) {
        try {
          await enqueueClose(actor, maintenanceScope);
          actor.backendClosed = true;
          if (!process.versions.bun) {
            actor.markNativeStopped();
          }
        } catch (error) {
          errors.push(error);
          fail(actor.slot, error instanceof Error ? error : new Error(String(error)));
          await actor.slot.exit;
        }
      }
      try {
        if (
          process.versions.bun ||
          actor.slot.failed ||
          (!actor.slot.pendingOpens && [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Bun retains native statements after close; keep pathname ownership until VM exit.
          await retire(actor.slot);
        }
      } catch (error) {
        errors.push(error);
      } finally {
        forget(actor);
      }
      throwSqliteLifecycleErrors(errors, "SQLite worker actor cleanup failed");
    })().finally(() => {
      actor.closing = undefined;
    });
    return actor.closing;
  }

  function forget(actor: Actor): void {
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
      throwSqliteLifecycleErrors(errors, "SQLite worker retirement cleanup failed");
    })().finally(() => {
      slot.retiring = undefined;
    });
    return slot.retiring;
  }

  return {
    createSlot,
    settleGeneration,
    releaseActorReference,
    rejectSlotAdmission,
    retireActor,
    closeActor,
    forget,
    retireEmpty,
    retire,
  };
}
