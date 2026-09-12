import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureSqliteWorkerOpen,
  findUnclaimedSharedStateActors,
  prepareSqliteWorkerActorContext,
  prepareSqliteWorkerDatabaseAdmission,
  resolveOpenedSqliteWorkerIdentity,
  resolveSqliteWorkerModuleUrl,
  validateSqliteWorkerDatabaseLocator,
} from "./sqlite-worker-broker-admission.js";
import {
  decodeSqliteWorkerReplyError,
  decodeSqliteWorkerReplyValue,
  prepareSqliteWorkerRequest,
  withSqliteWorkerCleanupFailure,
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
} from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerReply,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

const MAX_WORKERS = 4;
const MAX_STORES = 64;
const MAX_REQUESTS = 128;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const runOutsideCaller = AsyncLocalStorage.snapshot();

export class SqliteWorkerBroker {
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

  open<Operations extends SqliteWorkerOperations>(
    options: SqliteWorkerStoreOptions,
    stateContext?: SqliteWorkerStateContext,
    assertCurrent?: () => void,
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
    } catch (error) {
      this.clients.delete(client);
      return Promise.reject(toErrorObject(error, "SQLite worker input could not be serialized"));
    }
    const { input } = snapshot;
    if (
      input.byteLength > SQLITE_WORKER_MAX_MESSAGE_BYTES ||
      this.bytes + this.admissionBytes + input.byteLength > MAX_QUEUED_BYTES
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
    return previous
      .then(() => this.openAdmitted<Operations>(snapshot, client))
      .catch((error: unknown) => {
        this.clients.delete(client);
        throw error;
      })
      .finally(() => {
        this.admissionBytes -= input.byteLength;
        released.resolve();
      });
  }

  private async openAdmitted<Operations extends SqliteWorkerOperations>(
    options: PreparedSqliteWorkerOpen,
    client: object,
  ): Promise<SqliteWorkerStore<Operations> | undefined> {
    const { databasePath, inputHash, identity } =
      await prepareSqliteWorkerDatabaseAdmission(options);
    const input = options.input;
    const { key, canonicalPath } = identity;
    const admittedPaths = new Set([databasePath, canonicalPath]);
    if (
      [...this.actors.values()].some(
        (entry) =>
          entry.key !== key &&
          [...admittedPaths].some((pathname) => entry.pathReferences.has(pathname)),
      )
    ) {
      throw new Error(
        "SQLite database pathname changed while its worker owner is active; close the existing store first",
      );
    }
    if (options.existingOnly && !key.startsWith("file:")) {
      this.clients.delete(client);
      return undefined;
    }
    const { modulePath, moduleUrl } = await resolveSqliteWorkerModuleUrl(options.moduleUrl);
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
      const slot = await this.acquireSlot();
      actor = {
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
        { dispatchState: opening.openDispatch, assertCurrent: options.assertCurrent },
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
    try {
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
            await this.closeActor(actor);
          } else {
            if (actor.openDispatch.dispatched) {
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
    for (const pathname of admittedPaths) {
      owned.pathReferences.set(pathname, (owned.pathReferences.get(pathname) ?? 0) + 1);
    }
    let referenceReleased = false;
    const { store, client: storeClient } = createSqliteWorkerClient<Operations>({
      isDraining: () => this.draining !== undefined,
      isAvailable: () => !owned.slot.failed && !owned.cleanupState,
      dispatch: (payload, signal, scope, assertCurrent) =>
        this.enqueue(
          owned.slot,
          {
            type: "execute",
            actor: owned.id,
            input: payload,
            ...(scope?.stateContext ? { stateContext: scope.stateContext } : {}),
          },
          payload.byteLength,
          { signal, scope, assertCurrent },
        ),
      release: async () => {
        if (!referenceReleased) {
          referenceReleased = true;
          owned.references -= 1;
          this.stores.delete(store);
          this.clients.delete(client);
          for (const pathname of admittedPaths) {
            const references = owned.pathReferences.get(pathname) ?? 0;
            if (references > 1) {
              owned.pathReferences.set(pathname, references - 1);
            } else {
              owned.pathReferences.delete(pathname);
            }
          }
        }
        if (!owned.references) {
          await this.closeActor(owned);
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

  private async acquireSlot(): Promise<Slot> {
    const available = [...this.slots].filter((slot) => !slot.failed && !slot.retiring);
    if (this.slots.size >= MAX_WORKERS) {
      if (!available.length) {
        await Promise.race([...this.slots].map((slot) => slot.exit));
        return this.acquireSlot();
      }
      if (process.versions.bun) {
        throw new SqliteWorkerError(
          "Bun SQLite workers support at most four distinct open databases; close a store or use Node",
          "overloaded",
        );
      }
      const selected = available.reduce((left, right) =>
        left.actors.size <= right.actors.size ? left : right,
      );
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
    worker.on("message", (reply: SqliteWorkerReply) => {
      const job = slot.current;
      if (!job || reply.id !== job.request.id) {
        this.fail(slot, new Error("SQLite worker returned an unexpected response"));
        return;
      }
      if (!reply.ok) {
        const error = decodeSqliteWorkerReplyError(job, reply.error);
        if (job.request.type !== "execute" || reply.retire) {
          this.fail(slot, error, job.request.type !== "execute" ? error : undefined);
          return;
        }
        slot.current = undefined;
        this.finish(job, error);
        this.dispatch(slot);
        return;
      }
      let value: unknown;
      try {
        const result = decodeSqliteWorkerReplyValue(job, reply);
        if (result.type === "continue") {
          // Continuations retain the current job and its reserved transport credits through drain.
          slot.worker.postMessage(result.request, []);
          return;
        }
        value = result.value;
      } catch (error) {
        this.fail(slot, error);
        return;
      }
      slot.current = undefined;
      this.finish(job, undefined, value);
      this.dispatch(slot);
    });
    worker.on("error", (error) => this.fail(slot, error));
    worker.on("messageerror", (error) => this.fail(slot, error));
    worker.once("exit", (code) => {
      slot.exited = true;
      for (const actor of slot.actors) {
        actor.backendClosed = true;
      }
      this.fail(slot, new Error(`SQLite worker exited with code ${code}`));
      this.slots.delete(slot);
      exited.resolve();
    });
    worker.unref();
    return slot;
  }

  private enqueue(
    slot: Slot,
    body: RequestBody,
    bytes: number,
    { signal, dispatchState, scope, assertCurrent }: EnqueueOptions = {},
  ): Promise<unknown> {
    if (this.draining && body.type !== "close" && !scope?.active) {
      return Promise.reject(new SqliteWorkerError("SQLite worker host is closing", "closed"));
    }
    if (slot.failed) {
      return Promise.reject(slot.failed);
    }
    const activeInput = body.type === "execute" && bytes > MAX_QUEUED_BYTES;
    const reservedBytes = activeInput ? SQLITE_WORKER_MAX_MESSAGE_BYTES : bytes;
    if (
      body.type !== "close" &&
      ((body.type !== "execute" && bytes > SQLITE_WORKER_MAX_MESSAGE_BYTES) ||
        (activeInput && (slot.current || slot.queue.length > 0 || slot.pendingOpens > 0)) ||
        this.requests >= MAX_REQUESTS ||
        this.bytes + this.admissionBytes + reservedBytes > MAX_QUEUED_BYTES)
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker queue capacity reached", "overloaded"),
      );
    }
    const result = createDeferredCore<unknown>();
    const job: Job = {
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
    slot.current = job;
    job.detach();
    slot.worker.ref();
    try {
      job.assertCurrent?.();
      const actor = [...slot.actors].find((candidate) => candidate.id === job.request.actor);
      prepareSqliteWorkerActorContext(actor, job.request);
      const request = prepareSqliteWorkerRequest(job);
      slot.worker.postMessage(
        request,
        request.gatewaySchemaFence ? [request.gatewaySchemaFence] : [],
      );
      if (job.dispatchState) {
        job.dispatchState.dispatched = true;
      }
    } catch (error) {
      if (job.request.gatewaySchemaFence) {
        // A failed transfer cannot attest that the receiving native owner is gone.
        this.fail(slot, error, toErrorObject(error, "SQLite worker transfer failed"));
      } else {
        slot.current = undefined;
        this.finish(job, error);
        this.dispatch(slot);
      }
    }
  }

  private finish(job: Job, error?: unknown, value?: unknown): void {
    job.inputTransfer?.producer.cancel();
    job.inputTransfer = undefined;
    job.transfer = undefined;
    job.detach();
    this.requests -= 1;
    this.bytes -= job.bytes;
    if (error !== undefined) {
      job.reject(error);
    } else {
      job.resolve(value);
    }
  }

  private fail(slot: Slot, reason: unknown, currentError?: Error): void {
    if (slot.failed) {
      return;
    }
    const error = toErrorObject(reason, "SQLite worker failed");
    slot.failed = new SqliteWorkerError(error.message, "unavailable");
    const current = slot.current;
    slot.current = undefined;
    if (current) {
      current.inputTransfer?.producer.cancel();
      current.inputTransfer = undefined;
      current.transfer = undefined;
    }
    const queued = slot.queue.splice(0);
    // Join native exit before releasing any operation that might have touched SQLite.
    const finishFailed = (cleanupError?: unknown) => {
      if (current) {
        this.finish(
          current,
          withSqliteWorkerCleanupFailure(
            currentError ??
              new SqliteWorkerError(
                `SQLite worker stopped before its result was received: ${error.message}`,
                current.request.type === "execute" ? "outcome-unknown" : "unavailable",
              ),
            cleanupError,
          ),
        );
      }
      for (const job of queued) {
        this.finish(job, withSqliteWorkerCleanupFailure(slot.failed ?? error, cleanupError));
      }
    };
    void this.retire(slot).then(() => finishFailed(), finishFailed);
  }

  private closeActor(actor: Actor): Promise<void> {
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
          await this.enqueue(actor.slot, { type: "close", actor: actor.id }, 0);
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
          (!actor.slot.pendingOpens && [...actor.slot.actors].every((entry) => entry.backendClosed))
        ) {
          // Bun retains native statements after close; keep pathname ownership until VM exit.
          await this.retire(actor.slot);
        } else {
          this.releaseGatewaySchemaFence(actor);
        }
      } catch (error) {
        errors.push(error);
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

  private releaseGatewaySchemaFence(actor: Actor): void {
    const delegation = actor.gatewaySchemaFence;
    if (!delegation) {
      return;
    }
    try {
      delegation.release();
    } finally {
      if (delegation.closed) {
        actor.gatewaySchemaFence = undefined;
      }
    }
  }

  private forget(actor: Actor): void {
    if (actor.gatewaySchemaFence) {
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
    if (!slot.actors.size && !slot.pendingOpens) {
      await this.retire(slot);
    }
  }

  private retire(slot: Slot): Promise<void> {
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
          this.releaseGatewaySchemaFence(actor);
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
