import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
} from "../state/openclaw-state-worker-error.js";
import { SqliteSchemaVersionError } from "./sqlite-user-version.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type {
  SqliteWorkerReply,
  SqliteWorkerRequest,
  SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import { findStartupMaintenanceRequiredError } from "./startup-maintenance-required.js";

type ReplyError = Extract<SqliteWorkerReply, { ok: false }>["error"];
type Receipt = { worker: number; actor: number; writes: number };
type Operations = { append: { input: string; output: Receipt } };
type ControlledWorker = {
  id: number;
  live: boolean;
  autoExit: boolean;
  holdExecute: boolean;
  failure?: "execute" | "close";
  replyError?: ReplyError;
  requests: SqliteWorkerRequest[];
  terminationStarted: Promise<void>;
  finishTermination(): void;
  exit(): void;
  releaseReplies(): void;
};

const fixture = vi.hoisted(() => ({
  workers: [] as ControlledWorker[],
  events: [] as Array<{ type: "open" | "execute" | "close"; worker: number; actor: number }>,
  maxLive: 0,
  moduleLookup: undefined as { entered(): void; released: Promise<void> } | undefined,
  nativeOpen: vi.fn(() => {
    throw new Error("Unexpected native SQLite boundary");
  }),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  const { serialize } = await import("node:v8");
  const { createDeferredCore: deferred } = await import("../shared/deferred.js");
  class FakeWorker extends EventEmitter implements ControlledWorker {
    readonly id = fixture.workers.length + 1;
    live = true;
    autoExit = true;
    holdExecute = false;
    failure?: "execute" | "close";
    replyError?: ReplyError;
    readonly requests: SqliteWorkerRequest[] = [];
    private readonly terminating = deferred();
    private readonly terminated = deferred<number>();
    readonly terminationStarted = this.terminating.promise;
    private readonly actors = new Map<number, number>();
    private readonly replies: Array<() => void> = [];

    constructor() {
      super();
      fixture.workers.push(this);
      fixture.maxLive = Math.max(
        fixture.maxLive,
        fixture.workers.filter((worker) => worker.live).length,
      );
    }

    postMessage(request: SqliteWorkerRequest) {
      this.requests.push(request);
      const respond = () => {
        if (request.type !== "open" && request.type !== "execute" && request.type !== "close") {
          throw new Error(`Unexpected fixture transport request: ${request.type}`);
        }
        fixture.events.push({ type: request.type, worker: this.id, actor: request.actor });
        if (request.type === this.failure) {
          this.emit("message", {
            id: request.id,
            ok: false,
            retire: true,
            error: { name: "Error", message: `Fixture ${request.type} failed` },
          });
          return;
        }
        if (request.type === "execute" && this.replyError) {
          this.emit("message", {
            id: request.id,
            ok: false,
            error: structuredClone(this.replyError),
          });
          return;
        }
        let value: Receipt | undefined;
        if (request.type === "open") {
          this.actors.set(request.actor, 0);
        } else if (request.type === "close") {
          this.actors.delete(request.actor);
        } else {
          const before = this.actors.get(request.actor);
          if (before === undefined) {
            throw new Error("Fixture executed a closed actor");
          }
          this.actors.set(request.actor, before + 1);
          value = { worker: this.id, actor: request.actor, writes: before + 1 };
        }
        this.emit("message", { id: request.id, ok: true, value: serialize(value) });
      };
      if (request.type === "execute" && this.holdExecute) {
        this.replies.push(respond);
      } else {
        queueMicrotask(respond);
      }
    }

    releaseReplies() {
      this.holdExecute = false;
      for (const reply of this.replies.splice(0)) {
        queueMicrotask(reply);
      }
    }

    ref() {
      return this;
    }
    unref() {
      return this;
    }

    terminate(): Promise<number> {
      this.terminating.resolve();
      if (this.autoExit) {
        queueMicrotask(() => {
          this.finishTermination();
          this.exit();
        });
      }
      return this.terminated.promise;
    }

    finishTermination() {
      this.terminated.resolve(0);
    }

    exit() {
      if (this.live) {
        this.live = false;
        this.emit("exit", 0);
      }
    }
  }
  return { ...actual, Worker: FakeWorker };
});

// Keep actor, client, reply, and cleanup logic real; replace physical admission only.
vi.mock("./sqlite-worker-identity.js", () => ({
  readDatabasePathIdentity: async (databasePath: string) => ({
    key: `file:${databasePath}`,
    canonicalPath: databasePath,
  }),
}));
vi.mock("./sqlite-worker-broker-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-worker-broker-admission.js")>()),
  resolveSqliteWorkerModuleUrl: async (url: URL) => {
    const lookup = fixture.moduleLookup;
    fixture.moduleLookup = undefined;
    if (lookup) {
      lookup.entered();
      await lookup.released;
    }
    return { modulePath: url.pathname, moduleUrl: url.href };
  },
}));
vi.mock("./runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/sqlite.worker.mjs"),
}));
vi.mock("./bun-sqlite-library.js", () => ({ ensureSqliteLibrarySelected: vi.fn() }));
vi.mock("./node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-sqlite.js")>()),
  openNodeSqliteDatabase: fixture.nativeOpen,
}));
vi.mock("./state-database-coordinator.js", () => ({
  tryCreateGatewaySchemaFenceDelegate: () => undefined,
  tryCreateStateLifecycleDelegate: () => undefined,
  withStateDatabaseCoordinatorRuntimeDirectory: <T>(_runtime: unknown, run: () => T): T => run(),
}));
vi.mock("./sqlite-coordinator.js", () => ({ SqliteCoordinatorError: class extends Error {} }));
vi.mock("./sqlite-transaction.js", () => ({ retainSqliteWriteAdmissionService: () => () => {} }));

const backend = new URL("file:///synthetic/memory.mjs");
const foregroundBackend = new URL("file:///synthetic/foreground.mjs");
const brokers = new Set<SqliteWorkerBroker>();
const gates = new Set<ReturnType<typeof createDeferredCore<void>>>();
const originalBun = Object.getOwnPropertyDescriptor(process.versions, "bun");

function requiredFirst<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) {
    throw new Error("Synthetic fixture did not create its first owner");
  }
  return first;
}

function gate() {
  const value = createDeferredCore();
  gates.add(value);
  return value;
}

function broker() {
  const value = new SqliteWorkerBroker();
  brokers.add(value);
  return value;
}

async function open(owner: SqliteWorkerBroker, name: string, moduleUrl = backend) {
  const store = await owner.open<Operations>({
    moduleUrl,
    databasePath: `/synthetic/${name}.sqlite`,
    input: undefined,
  });
  if (!store) {
    throw new Error("Synthetic existing database did not open");
  }
  return store;
}

function append(store: SqliteWorkerStore<Operations>) {
  return store.execute({ type: "append", input: "synthetic" });
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );
  return {
    outcome,
    get settled() {
      return settled;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  fixture.workers.length = 0;
  fixture.events.length = 0;
  fixture.maxLive = 0;
  fixture.moduleLookup = undefined;
  fixture.nativeOpen.mockClear();
});

afterEach(async () => {
  expect.soft(fixture.nativeOpen).not.toHaveBeenCalled();
  expect.soft(fixture.workers.every((worker) => !worker.live)).toBe(true);
  for (const pending of gates) {
    pending.resolve();
  }
  for (const worker of fixture.workers) {
    worker.autoExit = true;
    worker.releaseReplies();
    worker.finishTermination();
  }
  // Release deliberately withheld native exits even when an assertion failed.
  for (const worker of fixture.workers) {
    worker.exit();
  }
  await Promise.allSettled([...brokers].map((owner) => owner.close()));
  gates.clear();
  brokers.clear();
  if (originalBun) {
    Object.defineProperty(process.versions, "bun", originalBun);
  } else {
    Reflect.deleteProperty(process.versions, "bun");
  }
});

describe("SQLite worker thread reservation", () => {
  it("registers its drain obligation before asynchronous module lookup", async () => {
    const owner = broker();
    const entered = createDeferredCore();
    const release = gate();
    fixture.moduleLookup = { entered: () => entered.resolve(), released: release.promise };
    const callback = vi.fn(async () => "started after drain");
    const scoped = observe(owner.withThreadReservation(backend, callback));
    await entered.promise;
    const drained = observe(owner.close());
    await nextTurn();
    expect(drained.settled).toBe(false);
    release.resolve();
    expect(await scoped.outcome).toMatchObject({ ok: false, error: { code: "closed" } });
    expect(await drained.outcome).toEqual({ ok: true, value: undefined });
    expect(callback).not.toHaveBeenCalled();
    expect(fixture.workers).toHaveLength(0);
  });

  it("closes the shadow actor before opening a distinct live actor on the same thread", async () => {
    const owner = broker();
    await owner.withThreadReservation(backend, async () => {
      const shadow = await open(owner, "shadow");
      const before = await append(shadow);
      await shadow.close();
      await expect(append(shadow)).rejects.toMatchObject({ code: "closed" });
      expect(requiredFirst(fixture.workers).live).toBe(true);
      const live = await open(owner, "live");
      const after = await append(live);
      expect(after).toEqual({ worker: before.worker, actor: expect.any(Number), writes: 1 });
      expect(after.actor).not.toBe(before.actor);
      expect(fixture.events.filter((event) => event.type !== "execute")).toEqual([
        { type: "open", worker: before.worker, actor: before.actor },
        { type: "close", worker: before.worker, actor: before.actor },
        { type: "open", worker: after.worker, actor: after.actor },
      ]);
      await live.close();
    });
    expect(fixture.workers).toHaveLength(1);
    expect(requiredFirst(fixture.workers).live).toBe(false);
  });

  it.each([false, true])(
    "joins an empty reservation's exit before scope and host drain (reject: %s)",
    async (reject) => {
      const owner = broker();
      const ready = createDeferredCore<ControlledWorker>();
      const release = gate();
      const failure = new Error("Callback failed");
      const scope = observe(
        owner.withThreadReservation(backend, async () => {
          const store = await open(owner, "shadow");
          await store.close();
          const worker = requiredFirst(fixture.workers);
          worker.autoExit = false;
          ready.resolve(worker);
          await release.promise;
          if (reject) {
            throw failure;
          }
          return "complete";
        }),
      );
      void scope.outcome.then((outcome) => {
        if (!outcome.ok) {
          ready.reject(outcome.error);
        }
      });
      const worker = await ready.promise;
      const drained = observe(owner.close());
      release.resolve();
      await worker.terminationStarted;
      worker.finishTermination();
      await nextTurn();
      expect(scope.settled).toBe(false);
      expect(drained.settled).toBe(false);
      worker.exit();
      expect(await scope.outcome).toEqual(
        reject ? { ok: false, error: failure } : { ok: true, value: "complete" },
      );
      expect(await drained.outcome).toEqual({ ok: true, value: undefined });
      expect(fixture.workers.every((entry) => !entry.live)).toBe(true);
    },
  );

  it("keeps a same-module nested reservation alive until the outer scope exits", async () => {
    const owner = broker();
    await owner.withThreadReservation(backend, async () => {
      const first = await open(owner, "first");
      const receipt = await append(first);
      await first.close();
      await owner.withThreadReservation(new URL(backend), async () => {
        const nested = await open(owner, "nested");
        expect((await append(nested)).worker).toBe(receipt.worker);
        await nested.close();
      });
      expect(requiredFirst(fixture.workers).live).toBe(true);
      const last = await open(owner, "last");
      expect((await append(last)).worker).toBe(receipt.worker);
      await last.close();
    });
    expect(fixture.workers).toHaveLength(1);
    expect(requiredFirst(fixture.workers).live).toBe(false);
  });

  it("refuses a matching open from an escaped closed scope without affecting other backends", async () => {
    const owner = broker();
    const escaped = await owner.withThreadReservation(backend, async () =>
      AsyncLocalStorage.snapshot(),
    );
    await expect(escaped(() => open(owner, "late"))).rejects.toMatchObject({ code: "closed" });
    expect(fixture.workers).toHaveLength(0);
    const unrelated = await escaped(() => open(owner, "unrelated", foregroundBackend));
    await expect(append(unrelated)).resolves.toMatchObject({ writes: 1 });
    await unrelated.close();
  });

  it("keeps ordinary Node placement within four workers", async () => {
    const owner = broker();
    const stores: SqliteWorkerStore<Operations>[] = [];
    const threads = new Set<number>();
    for (let index = 0; index < 8; index++) {
      const store = await open(owner, `foreground-${index}`, foregroundBackend);
      stores.push(store);
      threads.add((await append(store)).worker);
    }
    expect(threads.size).toBe(4);
    expect(fixture.maxLive).toBe(4);
    await Promise.all(stores.map((store) => store.close()));
  });

  it("retains the 64-client cap until accepted work and client close settle", async () => {
    const owner = broker();
    const stores: SqliteWorkerStore<Operations>[] = [];
    for (let index = 0; index < 64; index++) {
      stores.push(await open(owner, "shared"));
    }
    expect(fixture.workers).toHaveLength(1);
    await expect(open(owner, "shared")).rejects.toMatchObject({ code: "overloaded" });
    const worker = requiredFirst(fixture.workers);
    worker.holdExecute = true;
    const write = append(requiredFirst(stores));
    const closing = observe(requiredFirst(stores).close());
    await expect(open(owner, "shared")).rejects.toMatchObject({ code: "overloaded" });
    expect(closing.settled).toBe(false);
    worker.releaseReplies();
    await write;
    expect(await closing.outcome).toEqual({ ok: true, value: undefined });
    const replacement = await open(owner, "shared");
    await expect(open(owner, "shared")).rejects.toMatchObject({ code: "overloaded" });
    await Promise.all([...stores.slice(1), replacement].map((store) => store.close()));
  });

  it("withdraws an empty reservation under foreground pressure before allocating another thread", async () => {
    const owner = broker();
    const ready = createDeferredCore<ControlledWorker>();
    const resume = gate();
    const reserved = observe(
      owner.withThreadReservation(backend, async () => {
        const shadow = await open(owner, "shadow");
        await shadow.close();
        const worker = requiredFirst(fixture.workers);
        worker.autoExit = false;
        ready.resolve(worker);
        await resume.promise;
        const successor = await open(owner, "live");
        const receipt = await append(successor);
        await successor.close();
        return receipt;
      }),
    );
    void reserved.outcome.then((outcome) => {
      if (!outcome.ok) {
        ready.reject(outcome.error);
      }
    });
    const idle = await ready.promise;
    const foreground: SqliteWorkerStore<Operations>[] = [];
    for (let index = 0; index < 3; index++) {
      foreground.push(await open(owner, `foreground-${index}`, foregroundBackend));
    }
    const entering = observe(open(owner, "foreground-pressure", foregroundBackend));
    await idle.terminationStarted;
    idle.finishTermination();
    await nextTurn();
    expect(entering.settled).toBe(false);
    expect(fixture.workers).toHaveLength(4);
    idle.exit();
    const entered = await entering.outcome;
    if (!entered.ok) {
      throw entered.error;
    }
    foreground.push(entered.value);
    expect(
      new Set((await Promise.all(foreground.map(append))).map((receipt) => receipt.worker)).size,
    ).toBe(4);
    expect(fixture.maxLive).toBe(4);
    resume.resolve();
    const outcome = await reserved.outcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value.worker).not.toBe(idle.id);
    expect(fixture.maxLive).toBe(4);
    await Promise.all(foreground.map((store) => store.close()));
  });

  it.each(["execute", "close"] as const)(
    "joins poisoned %s retirement and refuses a reserved successor",
    async (failure) => {
      const owner = broker();
      await owner.withThreadReservation(backend, async () => {
        const store = await open(owner, "poisoned");
        const worker = requiredFirst(fixture.workers);
        worker.autoExit = false;
        worker.failure = failure;
        const operation = observe<Receipt | void>(
          failure === "execute" ? append(store) : store.close(),
        );
        const queued = failure === "execute" ? observe(append(store)) : undefined;
        await worker.terminationStarted;
        await expect(open(owner, "successor")).rejects.toMatchObject({ code: "unavailable" });
        worker.finishTermination();
        await nextTurn();
        expect(operation.settled).toBe(false);
        if (queued) {
          expect(queued.settled).toBe(false);
        }
        worker.exit();
        expect(await operation.outcome).toMatchObject({
          ok: false,
          error:
            failure === "execute"
              ? { code: "outcome-unknown" }
              : { message: "Fixture close failed" },
        });
        if (queued) {
          expect(await queued.outcome).toMatchObject({ ok: false, error: { code: "unavailable" } });
          expect(worker.requests.filter((request) => request.type === "execute")).toHaveLength(1);
        }
        await expect(open(owner, "successor-after-exit")).rejects.toMatchObject({
          code: "unavailable",
        });
        await Promise.allSettled([store.close()]);
      });
      expect(fixture.workers).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "preserves shared-state error classification through the broker (outcome unknown: %s)",
    async (outcomeUnknown) => {
      const owner = broker();
      const store = await owner.open<Operations>(
        { moduleUrl: backend, databasePath: "/synthetic/state.sqlite", input: undefined },
        {
          environment: { OPENCLAW_STATE_DIR: "/synthetic" },
          coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
        },
      );
      if (!store) {
        throw new Error("Synthetic shared-state store did not open");
      }
      try {
        const payload = encodeOpenClawStateWorkerError(
          new SqliteSchemaVersionError("newer schema"),
        );
        if (!payload) {
          throw new Error("Expected canonical payload");
        }
        const code = outcomeUnknown ? "outcome-unknown" : "gateway.maintenance_required";
        const name = outcomeUnknown ? "SqliteWorkerError" : "SqliteSchemaVersionError";
        const message = outcomeUnknown ? "write outcome unknown" : "newer schema";
        requiredFirst(fixture.workers).replyError = {
          name,
          message,
          code,
          sharedState: payload,
        };
        const outcome = await observe(append(store)).outcome;
        if (outcome.ok || !(outcome.error instanceof Error)) {
          throw new Error("Expected a transported worker failure");
        }
        const failure = outcome.error;
        expect(failure).toMatchObject({ name, message, code });
        const hydrated = hydrateOpenClawStateWorkerError(failure);
        if (outcomeUnknown) {
          expect(hydrated).toBe(failure);
          expect(findStartupMaintenanceRequiredError(failure)).toBeUndefined();
        } else {
          expect(hydrated).toBeInstanceOf(SqliteSchemaVersionError);
          expect(hydrated.message).toBe("newer schema");
          expect(findStartupMaintenanceRequiredError(hydrated)).toBe(hydrated);
        }
      } finally {
        await store.close();
      }
    },
  );

  it("leaves Bun on ordinary per-store workers and joins each exit", async () => {
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "fixture" });
    const owner = broker();
    await owner.withThreadReservation(backend, async () => {
      const stores: SqliteWorkerStore<Operations>[] = [];
      for (let index = 0; index < 5; index++) {
        stores.push(await open(owner, `bun-${index}`));
      }
      expect(fixture.workers).toHaveLength(5);
      const first = requiredFirst(fixture.workers);
      first.autoExit = false;
      const closing = observe(requiredFirst(stores).close());
      await first.terminationStarted;
      first.finishTermination();
      await nextTurn();
      expect(closing.settled).toBe(false);
      first.exit();
      expect(await closing.outcome).toEqual({ ok: true, value: undefined });
      const next = await open(owner, "bun-successor");
      expect((await append(next)).worker).not.toBe(first.id);
      await Promise.all([...stores.slice(1), next].map((store) => store.close()));
      expect(fixture.workers.every((worker) => !worker.live)).toBe(true);
    });
  });
});
