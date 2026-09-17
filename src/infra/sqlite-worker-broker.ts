import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureSqliteWorkerOpen,
  captureSqliteWorkerAdmissionPaths,
  findUnclaimedSharedStateActors,
  releaseSqliteWorkerActorCoordinators,
  prepareSqliteWorkerDatabaseAdmission,
  resolveOpenedSqliteWorkerIdentity,
  resolveSqliteWorkerModuleUrl,
  retainSqliteWorkerAdmissionCleanup,
  retainSqliteWorkerAdmissionPathReferences,
  validateSqliteWorkerDatabaseLocator,
} from "./sqlite-worker-broker-admission.js";
import {
  settleSqliteWorkerJob,
  bindSqliteWorkerReplies,
  dispatchSqliteWorkerSlotJob,
  settleFailedSqliteWorkerJobs,
} from "./sqlite-worker-broker-reply.js";
import {
  captureSqliteWorkerThreadScopes,
  retainSqliteWorkerThreadOpening,
  retireSqliteWorkerSlot,
  runSqliteWorkerThreadReservation,
  withdrawSqliteWorkerThreadReservation,
} from "./sqlite-worker-broker-thread.js";
import type {
  Actor,
  EnqueueOptions,
  Job,
  PreparedSqliteWorkerOpen,
  RequestBody,
  Slot,
  SqliteWorkerStoreOptions,
  SqliteWorkerThreadScope,
  StoreClient,
} from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const MAX_WORKERS = 4;
const MAX_STORES = 64;
export const SQLITE_WORKER_MAX_REQUESTS = 128;
export const SQLITE_WORKER_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const runOutsideCaller = AsyncLocalStorage.snapshot();

export class SqliteWorkerBroker {
  private readonly threadScopes = new AsyncLocalStorage<SqliteWorkerThreadScope>();
  private readonly actors = new Map<string, Actor>();
  private readonly slots = new Set<Slot>();
  private readonly clients = new Set<object>();
  private readonly stores = new Map<object, StoreClient>();
  private readonly operations = new Set<Promise<void>>();
  private nextActor = 0;
  private nextRequest = 0;
  private requests = 0;
  private bytes = 0;
  private admissionBytes = 0;
  private admissionTail: Promise<void> = Promise.resolve();
  private draining?: Promise<void>;

  withThreadReservation<T>(moduleUrl: URL, operation: () => Promise<T>): Promise<T> {
    return runSqliteWorkerThreadReservation(moduleUrl, operation, {
      threadScopes: this.threadScopes,
      operations: this.operations,
      isDraining: () => this.draining !== undefined,
      retireEmpty: (slot) => this.retireEmpty(slot),
    });
  }

  open<Operations extends SqliteWorkerOperations>(
    options: SqliteWorkerStoreOptions,
    stateContext?: SqliteWorkerStateContext,
    assertCurrent?: () => void,
    lifecycle?: Pick<PreparedSqliteWorkerOpen, "maintenanceScope" | "retainCleanup">,
  ): Promise<SqliteWorkerStore<Operations> | undefined> {
    try {
      validateSqliteWorkerDatabaseLocator(options.databasePath);
    } catch (error) {
      return Promise.reject(toErrorObject(error, "SQLite worker database locator is invalid"));
    }
    if (this.draining) {
      return Promise.reject(new SqliteWorkerError("SQLite worker host is closing", "closed"));
    }
    if (this.clients.size >= MAX_STORES) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker store capacity reached", "overloaded"),
      );
    }
    const client = {};
    this.clients.add(client);
    let snapshot: PreparedSqliteWorkerOpen;
    try {
      snapshot = captureSqliteWorkerOpen(options, stateContext, assertCurrent);
      snapshot.maintenanceScope = lifecycle?.maintenanceScope;
      snapshot.retainCleanup = lifecycle?.retainCleanup;
      snapshot.threadScopes = captureSqliteWorkerThreadScopes(this.threadScopes.getStore());
    } catch (error) {
      this.clients.delete(client);
      return Promise.reject(toErrorObject(error, "SQLite worker input could not be serialized"));
    }
    const { input } = snapshot;
    if (
      input.byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES ||
      this.bytes + this.admissionBytes + input.byteLength > SQLITE_WORKER_MAX_QUEUED_BYTES
    ) {
      this.clients.delete(client);
      return Promise.reject(
        new SqliteWorkerError("SQLite worker open input capacity reached", "overloaded"),
      );
    }
    const previous = this.admissionTail;
    const released = createDeferredCore();
    this.admissionTail = released.promise;
    this.admissionBytes += input.byteLength;
    // Opening can create the physical file. Publish its identity before admitting any alias.
    const opening = previous
      .then(() => this.openAdmitted<Operations>(snapshot, client))
      .catch((error: unknown) => {
        this.clients.delete(client);
        throw error;
      })
      .finally(() => {
        this.admissionBytes -= input.byteLength;
        released.resolve();
      });
    retainSqliteWorkerThreadOpening(snapshot.threadScopes, opening);
    return opening;
  }

  private async openAdmitted<Operations extends SqliteWorkerOperations>(
    options: PreparedSqliteWorkerOpen,
    client: object,
  ): Promise<SqliteWorkerStore<Operations> | undefined> {
    const { databasePath, inputHash, identity } =
      await prepareSqliteWorkerDatabaseAdmission(options);
    const input = options.input;
    const { key } = identity;
    const admittedPaths = captureSqliteWorkerAdmissionPaths(
      databasePath,
      identity,
      this.actors.values(),
    );
    if (options.existingOnly && !key.startsWith("file:")) {
      this.clients.delete(client);
      return undefined;
    }
    const { modulePath, moduleUrl } = await resolveSqliteWorkerModuleUrl(options.moduleUrl);
    const capturedScope = options.threadScopes?.find(({ scope }) => scope.moduleUrl === moduleUrl);
    if (capturedScope && (!capturedScope.active || capturedScope.scope.failure)) {
      throw (
        capturedScope.scope.failure ??
        new SqliteWorkerError("SQLite worker thread scope is closed", "closed")
      );
    }
    let actor = this.actors.get(key);
    if (actor?.cleanupState === "pending") {
      if (actor.closing) {
        await actor.closing;
        return this.openAdmitted(options, client);
      }
      throw new SqliteWorkerError(
        "SQLite worker cleanup is pending; retry close before reopening",
        "closed",
      );
    }
    if (actor) {
      if (actor.slot.failed) {
        throw actor.slot.failed;
      }
      if (actor.moduleUrl !== moduleUrl || actor.inputHash !== inputHash) {
        throw new Error("SQLite database already belongs to another worker backend");
      }
      actor.references += 1;
    } else {
      const slot = await this.acquireSlot(capturedScope?.scope);
      actor = {
        pendingStateLifecycles: new Set(),
        id: ++this.nextActor,
        key,
        // Native ownership pins its opening paths even after the first client closes.
        pathReferences: new Map([...admittedPaths].map((pathname) => [pathname, 1])),
        moduleUrl,
        inputHash,
        slot,
        references: 1,
        opened: Promise.resolve(),
        openDispatch: { dispatched: false },
        initialized: false,
        backendClosed: false,
        databasePath,
        stateContext: options.stateContext,
      };
      this.actors.set(key, actor);
      slot.actors.add(actor);
      slot.pendingOpens -= 1;
      const opening = actor;
      opening.opened = this.enqueue(
        slot,
        {
          type: "open",
          actor: actor.id,
          moduleUrl,
          databasePath,
          ...(options.existingOnly ? { existingIdentity: key } : {}),
          input,
          ...(/\.[cm]?ts$/.test(modulePath)
            ? { sourceLoaderUrl: import.meta.resolve("tsx/esm/api") }
            : {}),
        },
        input.byteLength,
        {
          createAdmission: options.createOpenAdmission,
          dispatchState: opening.openDispatch,
          assertCurrent: options.assertCurrent,
          maintenanceScope: options.maintenanceScope,
        },
      ).then(async () => {
        opening.initialized = true;
        const physical = await resolveOpenedSqliteWorkerIdentity(databasePath, identity, (id) => {
          const existing = this.actors.get(id);
          return existing !== undefined && existing !== opening;
        });
        if (physical !== key) {
          this.actors.delete(key);
          opening.key = physical;
          this.actors.set(physical, opening);
        }
      });
    }
    const admittedActor = actor;
    try {
      retainSqliteWorkerAdmissionCleanup(admittedActor, options.retainCleanup, () =>
        this.closeActor(admittedActor, options.maintenanceScope),
      );
      await actor.opened;
      if (actor.slot.failed) {
        throw actor.slot.failed;
      }
    } catch (error) {
      actor.references -= 1;
      if (!actor.references) {
        let cleanupFailure: { error: unknown } | undefined;
        try {
          if (actor.initialized) {
            await this.closeActor(actor, options.maintenanceScope);
          } else {
            if (
              (!actor.openDispatch.dispatched || actor.openDispatch.openNotEntered) &&
              !actor.slot.failed
            ) {
              actor.backendClosed = true;
            }
            if (actor.openDispatch.dispatched && !actor.openDispatch.openNotEntered) {
              // A throwing factory cannot prove that all partially opened native handles closed.
              this.fail(actor.slot, error);
              await actor.slot.exit;
            }
            this.forget(actor);
            await this.retireEmpty(actor.slot);
          }
        } catch (cleanupError) {
          cleanupFailure = { error: cleanupError };
        }
        if (cleanupFailure) {
          throw new AggregateError(
            [error, cleanupFailure.error],
            "SQLite worker admission and cleanup failed",
            { cause: error },
          );
        }
      }
      throw error;
    }
    const owned = actor;
    const releasePaths = retainSqliteWorkerAdmissionPathReferences(owned, admittedPaths);
    let referenceReleased = false;
    const { store, client: storeClient } = createSqliteWorkerClient<Operations>({
      isDraining: () => this.draining !== undefined,
      isAvailable: () => !owned.slot.failed && !owned.cleanupState,
      dispatch: (payload, signal, scope, assertCurrent, createAdmission) =>
        this.enqueue(
          owned.slot,
          {
            type: "execute",
            actor: owned.id,
            input: payload,
            ...(scope?.stateContext ? { stateContext: scope.stateContext } : {}),
          },
          payload.byteLength,
          {
            signal,
            scope,
            assertCurrent,
            createAdmission,
            maintenanceScope: options.maintenanceScope,
          },
        ),
      release: async () => {
        if (!referenceReleased) {
          referenceReleased = true;
          owned.references -= 1;
          this.stores.delete(store);
          this.clients.delete(client);
          releasePaths();
        }
        if (this.draining) {
          // Host drainage owns actor cleanup; it does not wait for client releases.
          await this.draining;
        } else if (owned.slot.failed) {
          // A nonlast client must still join the failed worker's native cleanup.
          await owned.slot.exit;
        }
        if (!owned.references) {
          await this.closeActor(owned, options.maintenanceScope);
        }
      },
    });
    this.stores.set(store, storeClient);
    return store;
  }

  runOperation<Operations extends SqliteWorkerOperations, T>(
    store: SqliteWorkerStore<Operations>,
    operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
    stateContext?: SqliteWorkerStateContext,
    assertCurrent?: (commandType: PropertyKey) => void,
    createAdmission?: SqliteWorkerAdmissionFactory,
  ): Promise<T> {
    const client = this.stores.get(store);
    if (!client || client.sealed || this.draining) {
      return Promise.reject(new SqliteWorkerError("SQLite worker store is closed", "closed"));
    }
    return runSqliteWorkerClientOperation(
      client,
      operation,
      stateContext,
      (pending) => {
        this.operations.add(pending);
        return () => this.operations.delete(pending);
      },
      assertCurrent,
      createAdmission,
    );
  }

  isAvailable(store: object): boolean {
    return this.stores.get(store)?.isAvailable() ?? false;
  }

  hasUnclaimedSharedStateCleanup(databasePath: string): boolean {
    return findUnclaimedSharedStateActors(this.actors.values(), databasePath).length > 0;
  }

  async closeUnclaimedSharedState(databasePath: string): Promise<void> {
    await this.admissionTail;
    const results = await Promise.allSettled(
      findUnclaimedSharedStateActors(this.actors.values(), databasePath).map((actor) =>
        this.closeActor(actor),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "SQLite worker unclaimed cleanup failed", {
        cause: errors[0],
      });
    }
  }

  private async acquireSlot(threadScope?: SqliteWorkerThreadScope): Promise<Slot> {
    if (threadScope?.failure) {
      throw threadScope.failure;
    }
    if (threadScope?.slot) {
      const slot = threadScope.slot;
      if (slot.failed || slot.retiring) {
        throw slot.failed ?? new SqliteWorkerError("SQLite worker thread is retiring", "closed");
      }
      slot.pendingOpens += 1;
      return slot;
    }
    const available = [...this.slots].filter((slot) => !slot.failed && !slot.retiring);
    // Return Bun to four shared workers after https://github.com/oven-sh/bun/pull/40005 ships.
    if (this.slots.size >= (process.versions.bun ? MAX_STORES : MAX_WORKERS)) {
      if (threadScope) {
        threadScope.placement = false;
      }
      const idleReservation = available.find(
        (slot) =>
          slot.threadScope &&
          !slot.actors.size &&
          !slot.pendingOpens &&
          !slot.current &&
          !slot.queue.length,
      );
      if (idleReservation) {
        withdrawSqliteWorkerThreadReservation(idleReservation);
        await retireSqliteWorkerSlot(idleReservation);
        return this.acquireSlot(threadScope);
      }
      if (!available.length || process.versions.bun) {
        const retiring = [...this.slots].filter((slot) => Boolean(slot.failed || slot.retiring));
        if (retiring.length > 0) {
          await Promise.race(retiring.map(({ exit }) => exit));
          return this.acquireSlot(threadScope);
        }
        if (process.versions.bun) {
          throw new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
        }
      }
      const selected = available.reduce((left, right) =>
        left.actors.size <= right.actors.size ? left : right,
      );
      // Capacity pressure returns this slot to the ordinary multiplexing policy.
      withdrawSqliteWorkerThreadReservation(selected);
      selected.pendingOpens += 1;
      return selected;
    }
    if (process.versions.bun && process.platform === "darwin") {
      ensureSqliteLibrarySelected();
    }
    const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteStore);
    const worker = runOutsideCaller(
      () =>
        new Worker(url, {
          execArgv: url.pathname.endsWith(".ts")
            ? ["--import", import.meta.resolve("tsx/esm")]
            : [],
        }),
    );
    const exited = createDeferredCore();
    const slot: Slot = {
      worker,
      actors: new Set(),
      queue: [],
      exit: exited.promise,
      exited: false,
      pendingOpens: 1,
    };
    this.slots.add(slot);
    if (threadScope?.placement) {
      slot.threadScope = threadScope;
      threadScope.slot = slot;
    }
    bindSqliteWorkerReplies(slot, {
      fail: (error, currentError) => this.fail(slot, error, currentError),
      finish: (pending, error, value, settlement) => this.finish(pending, error, value, settlement),
      dispatch: () => this.dispatch(slot),
      onExit: () => {
        this.slots.delete(slot);
        exited.resolve();
      },
    });
    worker.unref();
    return slot;
  }

  private enqueue(
    slot: Slot,
    body: RequestBody,
    bytes: number,
    {
      signal,
      dispatchState,
      scope,
      assertCurrent,
      createAdmission,
      maintenanceScope,
    }: EnqueueOptions = {},
  ): Promise<unknown> {
    if (this.draining && body.type !== "close" && !scope?.active) {
      return Promise.reject(new SqliteWorkerError("SQLite worker host is closing", "closed"));
    }
    if (slot.failed) {
      return Promise.reject(slot.failed);
    }
    const activeInput = body.type === "execute" && bytes > SQLITE_WORKER_MAX_QUEUED_BYTES;
    const reservedBytes = activeInput ? SQLITE_WORKER_MAX_MESSAGE_BYTES : bytes;
    if (
      body.type !== "close" &&
      ((body.type !== "execute" && bytes > SQLITE_WORKER_MAX_MESSAGE_BYTES) ||
        (activeInput && (slot.current || slot.queue.length > 0 || slot.pendingOpens > 0)) ||
        this.requests >= SQLITE_WORKER_MAX_REQUESTS ||
        this.bytes + this.admissionBytes + reservedBytes > SQLITE_WORKER_MAX_QUEUED_BYTES)
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded"),
      );
    }
    const result = createDeferredCore<unknown>();
    const job: Job = {
      maintenanceScope,
      createAdmission,
      assertCurrent,
      dispatchState,
      request: { ...body, id: ++this.nextRequest },
      bytes: reservedBytes,
      resolve: result.resolve,
      reject: result.reject,
      detach: () => signal?.removeEventListener("abort", abort),
    };
    const abort = () => {
      const index = slot.queue.indexOf(job);
      if (index >= 0) {
        slot.queue.splice(index, 1);
        this.finish(job, signal?.reason ?? new Error("SQLite worker operation canceled"));
      }
      // Once dispatched, retain the Promise until the database outcome is known.
    };
    this.requests += 1;
    this.bytes += reservedBytes;
    if (activeInput) {
      // A complete oversized value is active-operation memory, never retained in the bounded queue.
      if (signal?.aborted) {
        this.finish(job, signal.reason ?? new Error("SQLite worker operation canceled"));
      } else {
        this.dispatchJob(slot, job);
      }
      return result.promise;
    }
    slot.queue.push(job);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    this.dispatch(slot);
    return result.promise;
  }

  private dispatch(slot: Slot): void {
    if (slot.current || slot.failed) {
      return;
    }
    const job = slot.queue.shift();
    if (!job) {
      slot.worker.unref();
      return;
    }
    this.dispatchJob(slot, job);
  }

  private dispatchJob(slot: Slot, job: Job): void {
    dispatchSqliteWorkerSlotJob(slot, job, {
      fail: (error, currentError) => this.fail(slot, error, currentError),
      finish: (pending, error, value, settlement) => this.finish(pending, error, value, settlement),
      dispatch: () => this.dispatch(slot),
    });
  }

  private finish(
    job: Job,
    error?: unknown,
    value?: unknown,
    settlement?: SqliteWorkerOperationSettlement,
  ): void {
    this.requests -= 1;
    this.bytes -= job.bytes;
    settleSqliteWorkerJob(job, error, value, settlement);
  }

  private fail(slot: Slot, reason: unknown, currentError?: Error): void {
    if (slot.failed) {
      return;
    }
    const error = toErrorObject(reason, "SQLite worker failed");
    slot.failed = new SqliteWorkerError(error.message, "unavailable");
    if (slot.threadScope) {
      slot.threadScope.failure = slot.failed;
    }
    const current = slot.current;
    slot.current = undefined;
    if (current) {
      current.inputTransfer?.producer.cancel();
      current.inputTransfer = undefined;
      current.transfer = undefined;
    }
    const queued = slot.queue.splice(0);
    settleFailedSqliteWorkerJobs({
      queuedError: slot.failed,
      current,
      queued,
      error,
      currentError,
      retirement: retireSqliteWorkerSlot(slot),
      finish: (job, failure, value, settlement) => this.finish(job, failure, value, settlement),
    });
  }

  private closeActor(
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
          await this.enqueue(actor.slot, { type: "close", actor: actor.id }, 0, {
            maintenanceScope,
          });
          actor.backendClosed = true;
        } catch (error) {
          errors.push(error);
          this.fail(actor.slot, error instanceof Error ? error : new Error(String(error)));
          await actor.slot.exit;
        }
      } else if (firstAttempt && actor.slot.failed) {
        errors.push(actor.slot.failed);
      }
      try {
        if (
          process.versions.bun ||
          actor.slot.failed ||
          (!actor.slot.threadScope &&
            !actor.slot.pendingOpens &&
            [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Bun retains native statements after close; keep pathname ownership until VM exit.
          await retireSqliteWorkerSlot(actor.slot);
        } else {
          releaseSqliteWorkerActorCoordinators(actor);
        }
      } catch (error) {
        errors.push(error);
        if (actor.slot.threadScope) {
          actor.slot.threadScope.failure = toErrorObject(
            error,
            "SQLite worker coordinator cleanup failed",
          );
          try {
            await retireSqliteWorkerSlot(actor.slot);
          } catch (retirementError) {
            errors.push(retirementError);
          }
        }
      } finally {
        this.forget(actor);
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

  private forget(actor: Actor): void {
    if (actor.gatewaySchemaFence || actor.pendingStateLifecycles.size) {
      actor.cleanupState = "pending";
      return;
    }
    if (this.actors.get(actor.key) === actor) {
      this.actors.delete(actor.key);
    }
    actor.slot.actors.delete(actor);
    actor.cleanupState = "complete";
  }

  private async retireEmpty(slot: Slot): Promise<void> {
    if (!slot.threadScope && !slot.actors.size && !slot.pendingOpens) {
      await retireSqliteWorkerSlot(slot);
    }
  }

  close(): Promise<void> {
    this.draining ??= (async () => {
      for (const client of this.stores.values()) {
        client.sealed = true;
      }
      await this.admissionTail;
      await Promise.allSettled(this.operations);
      const results = await Promise.allSettled(
        [...this.actors.values()].map((actor) => this.closeActor(actor)),
      );
      results.push(
        ...(await Promise.allSettled([...this.slots].map((slot) => this.retireEmpty(slot)))),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "SQLite worker host cleanup failed");
      }
    })().finally(() => {
      this.clients.clear();
      this.stores.clear();
      this.draining = undefined;
    });
    return this.draining;
  }
}
