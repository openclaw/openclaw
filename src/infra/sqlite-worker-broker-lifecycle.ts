import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
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
import { SqliteWorkerError, type SqliteWorkerReply } from "./sqlite-worker-contract.js";
import type { SqliteWorkerInputAdmission } from "./sqlite-worker-input-admission.js";
import type { SqliteWorkerRuntimePreparation } from "./sqlite-worker-runtime-preparation.types.js";
import { createCpuTrackedWorker } from "./worker-cpu.js";

type RuntimeSource = { moduleUrl: string; carrierUrl: URL; sourceLoaderUrl?: string };

/** The broker retains these maps; this owner drains clients before native close custody. */
export function createSqliteWorkerLifecycle({
  explicitSqliteCloseReleasesNativeResources,
  actors,
  slots,
  stores,
  enqueueClose,
  fail,
}: {
  explicitSqliteCloseReleasesNativeResources: boolean;
  actors: Map<string, Actor>;
  slots: Set<Slot>;
  stores: Map<object, StoreClient>;
  enqueueClose: (
    actor: Actor,
    maintenanceScope?: EnqueueOptions["maintenanceScope"],
  ) => Promise<unknown>;
  fail: (slot: Slot, error: unknown) => void;
}) {
  const preparedRuntimes = new Map<
    SqliteWorkerRuntimePreparation,
    {
      slot: Slot;
      moduleUrl: string;
      carrierUrl: string;
      closeEpoch: number;
      preempted?: Promise<void>;
    }
  >();
  const reservedSlots = new Set<Slot>();
  let closeEpoch = 0;
  let completedCloseEpoch = 0;

  function prepareRuntime(
    source: RuntimeSource,
    maxWorkers: number,
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
  ): SqliteWorkerRuntimePreparation | undefined {
    if (slots.size >= maxWorkers) {
      return undefined;
    }
    const slot = createSlot(source, false, createReplyOwner, source);
    reservedSlots.add(slot);
    let releasing: Promise<void> | undefined;
    const prepared: SqliteWorkerRuntimePreparation = Object.freeze({
      release() {
        if (!preparedRuntimes.delete(prepared)) {
          return releasing ?? Promise.resolve();
        }
        reservedSlots.delete(slot);
        releasing = retire(slot);
        return releasing;
      },
    });
    preparedRuntimes.set(prepared, {
      slot,
      moduleUrl: source.moduleUrl,
      carrierUrl: source.carrierUrl.href,
      closeEpoch: closeEpoch + 1,
    });
    return prepared;
  }

  function beginClose(): number {
    return ++closeEpoch;
  }

  async function finishClose(epoch: number, succeeded: boolean): Promise<void> {
    const results = await Promise.allSettled([
      ...[...preparedRuntimes].flatMap(([prepared, runtime]) =>
        succeeded && runtime.closeEpoch === epoch && (runtime.preempted || !runtime.slot.failed)
          ? runtime.preempted
            ? [runtime.preempted]
            : []
          : [prepared.release()],
      ),
      ...[...slots].filter((slot) => !reservedSlots.has(slot)).map(retireEmpty),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      await Promise.allSettled([...preparedRuntimes.keys()].map((prepared) => prepared.release()));
      throwSqliteLifecycleErrors(errors, "SQLite prepared runtime cleanup failed");
    }
    if (succeeded) {
      completedCloseEpoch = epoch;
    }
  }

  async function closeHost({
    inputAdmission,
    operations,
    waiters,
  }: {
    inputAdmission: Pick<
      SqliteWorkerInputAdmission,
      "invalidatePreparations" | "joinOpens" | "joinPreparations"
    >;
    operations: Iterable<Promise<void>>;
    waiters: Iterable<Iterable<(error?: unknown) => void>>;
  }): Promise<void> {
    const epoch = beginClose();
    // Seal clients and pending dispatch before the first await; accepted scopes still settle.
    inputAdmission.invalidatePreparations();
    for (const waiting of waiters) {
      for (const resume of waiting) {
        resume(new SqliteWorkerError("SQLite worker host is closing", "overloaded"));
      }
    }
    for (const client of stores.values()) {
      client.sealed = true;
    }
    const errors: unknown[] = [];
    try {
      await inputAdmission.joinOpens();
      await Promise.allSettled(operations);
      const results = await Promise.allSettled(
        [...actors.values()].map((actor) => closeActor(actor)),
      );
      errors.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      await inputAdmission.joinPreparations();
    } catch (error) {
      errors.push(error);
    }
    try {
      await finishClose(epoch, errors.length === 0);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "SQLite worker host cleanup failed");
    }
  }

  async function consumeRuntimePreparation(
    options: PreparedSqliteWorkerOpen,
    moduleUrl: string,
  ): Promise<Slot | undefined> {
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
    const prepared = options.runtimePreparation;
    const runtime = prepared ? preparedRuntimes.get(prepared) : undefined;
    if (
      !prepared ||
      !runtime ||
      options.target ||
      options.runtimeGeneration ||
      runtime.closeEpoch !== closeEpoch ||
      completedCloseEpoch !== closeEpoch ||
      runtime.moduleUrl !== moduleUrl ||
      runtime.carrierUrl !== options.carrierUrl.href ||
      (!runtime.preempted && (runtime.slot.failed || runtime.slot.retiring || runtime.slot.exited))
    ) {
      if (runtime && prepared) {
        await racePromiseWithAbortSignal(
          prepared.release(),
          options.signal,
          (signal) => signal.reason,
        );
      }
      throw new SqliteWorkerError("SQLite prepared runtime is no longer available", "closed");
    }
    preparedRuntimes.delete(prepared);
    reservedSlots.delete(runtime.slot);
    if (runtime.preempted) {
      await racePromiseWithAbortSignal(
        runtime.preempted,
        options.signal,
        (signal) => signal.reason,
      );
      options.assertCurrent?.();
      options.signal?.throwIfAborted();
      if (runtime.closeEpoch !== closeEpoch || completedCloseEpoch !== closeEpoch) {
        throw new SqliteWorkerError("SQLite prepared runtime close epoch changed", "closed");
      }
      return undefined;
    }
    runtime.slot.pendingOpens += 1;
    return runtime.slot;
  }

  async function acquireSlot(
    options: PreparedSqliteWorkerOpen,
    moduleUrl: string,
    limits: { maxWorkers: number; maxStores: number },
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
  ): Promise<Slot> {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
    if (options.runtimePreparation) {
      const prepared = await consumeRuntimePreparation(options, moduleUrl);
      return (
        prepared ??
        acquireSlot(
          { ...options, runtimePreparation: undefined },
          moduleUrl,
          limits,
          createReplyOwner,
        )
      );
    }
    const shareWorkers = explicitSqliteCloseReleasesNativeResources;
    const hasEphemeral = Boolean(options.target) || [...slots].some((slot) => slot.ephemeral);
    const available = [...slots].filter(
      (slot) =>
        !slot.ephemeral &&
        !slot.failed &&
        !slot.retiring &&
        !reservedSlots.has(slot) &&
        slot.runtimeGeneration === options.runtimeGeneration,
    );
    // A retained updater cannot borrow another generation's carrier or evict its actors.
    // One extra slot belongs to the broker, not to each generation requesting one.
    const borrowedGenerationSlot =
      shareWorkers &&
      !hasEphemeral &&
      options.runtimeGeneration !== undefined &&
      available.length === 0 &&
      slots.size >= limits.maxWorkers &&
      ![...slots].some((slot) => slot.borrowedGenerationSlot);
    if (
      !borrowedGenerationSlot &&
      slots.size >= (shareWorkers || hasEphemeral ? limits.maxWorkers : limits.maxStores)
    ) {
      if (options.target || !available.length || !shareWorkers) {
        const optional = [...preparedRuntimes.values()].find(
          (runtime) =>
            reservedSlots.has(runtime.slot) && !runtime.preempted && !runtime.slot.failed,
        );
        if (optional) {
          // Accepted native work owns capacity before speculative code preparation.
          reservedSlots.delete(optional.slot);
          optional.preempted = retire(optional.slot);
          await racePromiseWithAbortSignal(
            optional.preempted,
            options.signal,
            (signal) => signal.reason,
          );
          return acquireSlot(options, moduleUrl, limits, createReplyOwner);
        }
        const retiring = [...slots].filter((slot) => Boolean(slot.failed || slot.retiring));
        if (retiring.length > 0) {
          await racePromiseWithAbortSignal(
            Promise.race(retiring.map(({ exit }) => exit)),
            options.signal,
            (signal) => signal.reason,
          );
          return acquireSlot(options, moduleUrl, limits, createReplyOwner);
        }
        throw new SqliteWorkerError(
          `SQLite worker ${shareWorkers ? "runtime" : "store"} capacity reached`,
          "overloaded",
        );
      }
      const selected = available.reduce((left, right) =>
        left.actors.size <= right.actors.size ? left : right,
      );
      selected.pendingOpens += 1;
      return selected;
    }
    return createSlot(options, borrowedGenerationSlot, createReplyOwner);
  }

  function createSlot(
    options: Pick<
      PreparedSqliteWorkerOpen,
      "carrierUrl" | "runtimeGeneration" | "target" | "assertCurrent" | "signal"
    >,
    borrowedGenerationSlot: boolean,
    createReplyOwner: (slot: Slot) => SqliteWorkerReplyOwner,
    runtimeSource?: RuntimeSource,
  ): Slot {
    options.signal?.throwIfAborted();
    ensureSqliteLibrarySelected();
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
    // Slot listeners share this closure scope; never capture the opening admission in it.
    const { carrierUrl } = options;
    const { worker, exited } = runInDetachedAsyncContext(() => ({
      worker: createCpuTrackedWorker(carrierUrl, {
        resourceLimits: { maxOldGenerationSizeMb: 512 },
        env: resolveNodeCompileCacheEnv(),
        execArgv: resolveRuntimeWorkerThreadExecArgv(carrierUrl),
        ...(runtimeSource
          ? {
              workerData: {
                sqliteRuntimePreparation: {
                  moduleUrl: runtimeSource.moduleUrl,
                  sourceLoaderUrl: runtimeSource.sourceLoaderUrl,
                },
              },
            }
          : {}),
      }),
      exited: createDeferredCore(),
    }));
    const slot: Slot = {
      ...(options.target ? { ephemeral: true as const } : {}),
      runtimeGeneration: options.runtimeGeneration,
      ...(borrowedGenerationSlot ? { borrowedGenerationSlot: true as const } : {}),
      worker,
      receiveReply: (reply) => receiveSqliteWorkerReply(slot, reply, replyOwner),
      actors: new Set(),
      queue: [],
      exit: exited.promise,
      exited: false,
      pendingOpens: runtimeSource ? 0 : 1,
    };
    const replyOwner = createReplyOwner(slot);
    slots.add(slot);
    worker.on("message", (reply: SqliteWorkerReply) => slot.receiveReply(reply));
    worker.on("error", (error) => fail(slot, error));
    worker.on("messageerror", (error) => fail(slot, error));
    worker.once("exit", (code) => {
      slot.exited = true;
      fail(slot, new Error(`SQLite worker exited with code ${code}`));
      for (const actor of slot.actors) {
        actor.backendClosed = true;
        actor.markNativeStopped();
      }
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
          if (explicitSqliteCloseReleasesNativeResources) {
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
          !explicitSqliteCloseReleasesNativeResources ||
          actor.slot.failed ||
          (!actor.slot.pendingOpens && [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Unproven close retains pathname ownership until VM exit.
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
    prepareRuntime,
    consumeRuntimePreparation,
    closeHost,
    acquireSlot,
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
