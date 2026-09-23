import { availableParallelism } from "node:os";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertSqliteWorkerActorReusable,
  captureSqliteWorkerOpen,
  captureSqliteWorkerAdmissionPaths,
  findUnclaimedSharedStateActors,
  closeUnclaimedSharedStateActors,
  releaseSqliteWorkerActorCoordinators,
  prepareSqliteWorkerDatabaseAdmission,
  resolveOpenedSqliteWorkerIdentity,
  resolveSqliteWorkerModuleUrl,
  retainSqliteWorkerAdmissionCleanup,
  retainSqliteWorkerAdmissionPathReferences,
  validateSqliteWorkerDatabaseLocator,
} from "./sqlite-worker-broker-admission.js";
import { createSqliteWorkerLifecycle } from "./sqlite-worker-broker-lifecycle.js";
import {
  settleSqliteWorkerJob,
  dispatchSqliteWorkerJob,
  settleFailedSqliteWorkerJobs,
  type CompletedSqliteWorkerOutcome,
} from "./sqlite-worker-broker-reply.js";
import type {
  Actor,
  EnqueueOptions,
  Job,
  PreparedSqliteWorkerOpen,
  RequestBody,
  Slot,
  SqliteWorkerStoreOptions,
  StoreClient,
  SqliteWorkerOpenCustody,
  SqliteWorkerInputPreparation,
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
import { SqliteWorkerInputAdmission } from "./sqlite-worker-input-admission.js";
import type { SqliteWorkerAdmissionFactory } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const ADMISSION_TIMEOUT_MS = 10_000;
const MAX_STORES = 64;
export const SQLITE_WORKER_MAX_REQUESTS = 128;
export const SQLITE_WORKER_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export class SqliteWorkerBroker {
  // WAL readers on independent actors can progress on separate threads without blocking writers.
  private readonly maxWorkers = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 8)));
  private readonly waiters = new Map<(error?: unknown) => void, Slot>();
  private resuming = false;
  private nextAdmissionWarning = 0;
  private readonly actors = new Map<string, Actor>();
  private readonly slots = new Set<Slot>();
  private readonly clients = new Set<object>();
  private readonly stores = new Map<object, StoreClient>();
  private readonly operations = new Set<Promise<void>>();
  private readonly lifecycle = createSqliteWorkerLifecycle({
    actors: this.actors,
    slots: this.slots,
    stores: this.stores,
    enqueueClose: (actor, maintenanceScope) =>
      this.enqueue(actor.slot, { type: "close", actor: actor.id }, 0, { maintenanceScope }),
    fail: (slot, error) => this.fail(slot, error),
  });
  private nextActor = 0;
  private nextRequest = 0;
  private requests = 0;
  private bytes = 0;
  private readonly inputAdmission = new SqliteWorkerInputAdmission({
    queuedBytes: () => this.bytes,
    isClosing: () => this.draining !== undefined,
    maxQueuedBytes: SQLITE_WORKER_MAX_QUEUED_BYTES,
    maxMessageBytes: SQLITE_WORKER_MAX_MESSAGE_BYTES,
  });
  private draining?: Promise<void>;

  reserveInputPreparation(inputBytes: number): SqliteWorkerInputPreparation {
    return this.inputAdmission.reserveInputPreparation(inputBytes);
  }

  open<Operations extends SqliteWorkerOperations>(
    options: SqliteWorkerStoreOptions,
    stateContext?: SqliteWorkerStateContext,
    assertCurrent?: () => void,
    custody: SqliteWorkerOpenCustody = {},
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
      snapshot = captureSqliteWorkerOpen(options, stateContext, assertCurrent, custody);
      const generation = options.runtimeGeneration;
      generation?.retain(this, async () => {
        await this.inputAdmission.joinOpens();
        await this.lifecycle.closeGeneration(generation);
      });
    } catch (error) {
      this.clients.delete(client);
      return Promise.reject(toErrorObject(error, "SQLite worker input could not be serialized"));
    }
    return this.inputAdmission
      .open(snapshot.input.byteLength + (snapshot.preparation?.byteLength ?? 0), () =>
        this.openAdmitted<Operations>(snapshot, client),
      )
      .catch((error: unknown) => {
        this.clients.delete(client);
        throw error;
      });
  }

  private async openAdmitted<Operations extends SqliteWorkerOperations>(
    options: PreparedSqliteWorkerOpen,
    client: object,
  ): Promise<SqliteWorkerStore<Operations> | undefined> {
    options.assertCurrent?.();
    const { databasePath, inputHash, identity } =
      await prepareSqliteWorkerDatabaseAdmission(options);
    options.assertCurrent?.();
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
    options.assertCurrent?.();
    let actor = this.actors.get(key);
    if (actor?.retirementRequested) {
      if (actor.retirement) {
        await actor.retirement;
        return this.openAdmitted(options, client);
      }
      throw new SqliteWorkerError("SQLite actor retirement must finish before reopening", "closed");
    }
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
      assertSqliteWorkerActorReusable(actor, moduleUrl, inputHash, options.stateContext);
      actor.references += 1;
    } else {
      const slot = await this.acquireSlot(options);
      try {
        options.assertCurrent?.();
      } catch (error) {
        return this.lifecycle.rejectSlotAdmission(slot, error);
      }
      const nativeStopped = createDeferredCore();
      actor = {
        runtimeGeneration: options.runtimeGeneration,
        nativeStopped: nativeStopped.promise,
        markNativeStopped: nativeStopped.resolve,
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
        stateDatabasePath: options.stateDatabasePath,
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
          ...(options.createAdmission
            ? { openAdmission: "input" as const }
            : options.createOpenAdmission
              ? { openAdmission: "identity" as const }
              : {}),
          ...(options.existingOnly ? { existingIdentity: key } : {}),
          input,
          ...(options.preparation ? { preparation: options.preparation } : {}),
          ...(/\.[cm]?ts$/.test(modulePath)
            ? { sourceLoaderUrl: import.meta.resolve("tsx/esm/api") }
            : {}),
        },
        input.byteLength + (options.preparation?.byteLength ?? 0),
        {
          dispatchState: opening.openDispatch,
          assertCurrent: options.assertCurrent,
          maintenanceScope: options.maintenanceScope,
          createAdmission: options.createAdmission ?? options.createOpenAdmission,
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
        this.lifecycle.closeActor(admittedActor, options.maintenanceScope),
      );
      options.onNativeStopped?.(actor.nativeStopped);
      await actor.opened;
      options.assertCurrent?.();
      if (actor.retirementRequested) {
        throw new SqliteWorkerError("SQLite actor retired during client admission", "closed");
      }
      if (actor.slot.failed) {
        throw actor.slot.failed;
      }
    } catch (error) {
      this.lifecycle.releaseActorReference(actor);
      if (!actor.references) {
        const errors = [error];
        try {
          if (actor.initialized) {
            await this.lifecycle.closeActor(actor, options.maintenanceScope);
          } else {
            if (
              (!actor.openDispatch.dispatched || actor.openDispatch.openNotEntered) &&
              !actor.slot.failed
            ) {
              actor.backendClosed = true;
              actor.markNativeStopped();
              actor.cleanupState = "pending";
              releaseSqliteWorkerActorCoordinators(actor);
            }
            if (actor.openDispatch.dispatched && !actor.openDispatch.openNotEntered) {
              // A throwing factory cannot prove that all partially opened native handles closed.
              this.fail(actor.slot, error);
              await actor.slot.exit;
            }
            this.lifecycle.forget(actor);
            await this.lifecycle.retireEmpty(actor.slot);
          }
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "SQLite worker admission and cleanup failed", {
            cause: error,
          });
        }
      }
      throw error;
    }
    const owned = actor;
    const releasePaths = retainSqliteWorkerAdmissionPathReferences(owned, admittedPaths);
    let referenceReleased = false;
    const { store, client: storeClient } = createSqliteWorkerClient<Operations>({
      actor: owned,
      isDraining: () => this.draining !== undefined,
      isAvailable: () => !owned.slot.failed && !owned.cleanupState && !owned.retirementRequested,
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
          this.lifecycle.releaseActorReference(owned);
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
          await this.lifecycle.closeActor(owned, options.maintenanceScope);
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
    requireStateLifecycle = false,
  ): Promise<T> {
    return runSqliteWorkerClientOperation(
      this.draining ? undefined : this.stores.get(store),
      operation,
      stateContext,
      (pending) => {
        this.operations.add(pending);
        return () => this.operations.delete(pending);
      },
      assertCurrent,
      createAdmission,
      requireStateLifecycle,
    );
  }

  isAvailable(store: object): boolean {
    return this.stores.get(store)?.isAvailable() ?? false;
  }

  retireActor(identity: object): Promise<void> {
    return this.lifecycle.retireActor(identity);
  }

  getActorIdentity(store: object): object {
    const client = this.stores.get(store);
    if (!client || client.sealed || !client.actor.stateContext || !client.isAvailable()) {
      throw new SqliteWorkerError("SQLite shared actor binding is unavailable", "closed");
    }
    return client.actor;
  }

  hasUnclaimedSharedStateCleanup(databasePath: string): boolean {
    return findUnclaimedSharedStateActors(this.actors.values(), databasePath).length > 0;
  }

  async closeUnclaimedSharedState(databasePath: string): Promise<void> {
    await this.inputAdmission.joinOpens();
    await closeUnclaimedSharedStateActors(this.actors.values(), databasePath, (actor) =>
      this.lifecycle.closeActor(actor),
    );
  }

  private async acquireSlot(options: PreparedSqliteWorkerOpen): Promise<Slot> {
    options.assertCurrent?.();
    const available = [...this.slots].filter(
      (slot) =>
        !slot.failed && !slot.retiring && slot.runtimeGeneration === options.runtimeGeneration,
    );
    // A retained updater cannot borrow another generation's carrier or evict its actors.
    // One extra slot belongs to the broker, not to each generation requesting one.
    const borrowedGenerationSlot =
      !process.versions.bun &&
      options.runtimeGeneration !== undefined &&
      available.length === 0 &&
      this.slots.size >= this.maxWorkers &&
      ![...this.slots].some((slot) => slot.borrowedGenerationSlot);
    // Return Bun to shared workers after https://github.com/oven-sh/bun/pull/40005 ships.
    if (
      !borrowedGenerationSlot &&
      this.slots.size >= (process.versions.bun ? MAX_STORES : this.maxWorkers)
    ) {
      if (!available.length || process.versions.bun) {
        const retiring = [...this.slots].filter((slot) => Boolean(slot.failed || slot.retiring));
        if (retiring.length > 0) {
          await Promise.race(retiring.map(({ exit }) => exit));
          return this.acquireSlot(options);
        }
        if (process.versions.bun) {
          throw new SqliteWorkerError("SQLite worker store capacity reached", "overloaded");
        }
        if (!available.length) {
          throw new SqliteWorkerError("SQLite worker runtime capacity reached", "overloaded");
        }
      }
      const selected = available.reduce((left, right) =>
        left.actors.size <= right.actors.size ? left : right,
      );
      selected.pendingOpens += 1;
      return selected;
    }
    return this.lifecycle.createSlot(options, borrowedGenerationSlot, (slot) => ({
      fail: (reason, currentError, completed, openOutcome) =>
        this.fail(slot, reason, currentError, completed, openOutcome),
      finish: (job, error, value, settlement) => this.finish(job, error, value, settlement),
      dispatch: () => this.dispatch(slot),
    }));
  }

  private enqueue(
    slot: Slot,
    body: RequestBody,
    bytes: number,
    options: EnqueueOptions = {},
  ): Promise<unknown> {
    const { signal, dispatchState, scope, assertCurrent, createAdmission, maintenanceScope } =
      options;
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
        this.bytes + this.inputAdmission.retainedBytes + reservedBytes >
          SQLITE_WORKER_MAX_QUEUED_BYTES)
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded"),
      );
    }
    if (body.type !== "close" && this.requests >= SQLITE_WORKER_MAX_REQUESTS) {
      // Oversized active inputs cannot be retained in an admission queue.
      if (activeInput || this.draining) {
        return Promise.reject(
          new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded"),
        );
      }
      return this.waitForCapacity(slot, body, bytes, options);
    }
    const result = createDeferredCore<unknown>();
    const job: Job = {
      requireStateLifecycle: scope?.requireStateLifecycle,
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
      if (slot.current === job && !job.nativeDispatched) {
        job.cancelPreparation?.abort(signal?.reason);
      }
      // Once dispatched, retain the Promise until the database outcome is known.
    };
    this.requests += 1;
    this.bytes += reservedBytes;
    if (activeInput) {
      signal?.addEventListener("abort", abort, { once: true });
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

  private waitForCapacity(
    slot: Slot,
    body: RequestBody,
    bytes: number,
    options: EnqueueOptions,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const signal = options.signal;
      const resume = (error?: unknown) => {
        if (!this.waiters.delete(resume)) {
          return;
        }
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        releaseInput();
        let failure = error;
        if (failure === undefined && Date.now() - started >= ADMISSION_TIMEOUT_MS) {
          this.warnAdmission(Date.now() - started);
          failure = new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded");
        }
        if (failure !== undefined) {
          reject(toErrorObject(failure, "SQLite worker admission failed"));
        } else {
          resolve(this.enqueue(slot, body, bytes, options));
        }
      };
      const abort = () => resume(signal?.reason ?? new Error("SQLite worker operation canceled"));
      const timer = setTimeout(() => {
        this.warnAdmission(Date.now() - started);
        resume(new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded"));
      }, ADMISSION_TIMEOUT_MS);
      const releaseInput = this.inputAdmission.retain(bytes);
      this.waiters.set(resume, slot);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      } else if (this.waiters.size >= SQLITE_WORKER_MAX_REQUESTS) {
        this.warnAdmission(0);
      }
    });
  }

  private warnAdmission(waitMs: number): void {
    const now = Date.now();
    if (now >= this.nextAdmissionWarning) {
      this.nextAdmissionWarning = now + ADMISSION_TIMEOUT_MS;
      getChildLogger({ subsystem: "infra/sqlite-worker" }).warn("SQLite worker admission delayed", {
        queueDepth: this.waiters.size,
        waitMs,
      });
    }
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
    slot.current = job;
    slot.worker.ref();
    dispatchSqliteWorkerJob(slot, job, (error, retire) => {
      // Slot failure owns settlement after joining preparation and native retirement.
      if (slot.current !== job) {
        return;
      }
      if (retire) {
        // Retire uncertain transfers or failed prepared-custody cleanup before settlement.
        this.fail(
          slot,
          error,
          job.nativeDispatched ? undefined : toErrorObject(error, "SQLite worker transfer failed"),
        );
      } else {
        slot.current = undefined;
        this.finish(job, error);
        this.dispatch(slot);
      }
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
    if (!this.resuming) {
      this.resuming = true;
      while (this.requests < SQLITE_WORKER_MAX_REQUESTS && this.waiters.size) {
        this.waiters.keys().next().value?.();
      }
      this.resuming = false;
    }
  }

  private fail(
    slot: Slot,
    reason: unknown,
    currentError?: Error,
    completed?: CompletedSqliteWorkerOutcome,
    openOutcome?: "refused-before-agent-open",
  ): void {
    if (slot.failed) {
      return;
    }
    const error = toErrorObject(reason, "SQLite worker failed");
    slot.failed = new SqliteWorkerError(error.message, "unavailable");
    for (const [resume, waitingSlot] of this.waiters) {
      if (waitingSlot === slot) {
        resume(slot.failed);
      }
    }
    if (completed) {
      slot.retiredAfterCompletion = true;
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
      completed,
      openOutcome,
      retire: () => this.lifecycle.retire(slot),
      finish: (job, failure, value, settlement) => this.finish(job, failure, value, settlement),
    });
  }

  close(): Promise<void> {
    this.draining ??= (async () => {
      // Preparing callers retain their byte charge until they settle, but cannot dispatch later.
      this.inputAdmission.invalidatePreparations();
      for (const resume of this.waiters.keys()) {
        resume(new SqliteWorkerError("SQLite worker host is closing", "overloaded"));
      }
      for (const client of this.stores.values()) {
        client.sealed = true;
      }
      await this.inputAdmission.joinOpens();
      await Promise.allSettled(this.operations);
      const results = await Promise.allSettled(
        [...this.actors.values()].map((actor) => this.lifecycle.closeActor(actor)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      await this.inputAdmission.joinPreparations();
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
