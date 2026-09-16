import type { EventEmitter } from "node:events";
import path from "node:path";
import { serialize } from "node:v8";
import { MessageChannel } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

type ControlledWorker = EventEmitter & {
  pending: Map<number, SqliteWorkerRequest>;
  holdRetirement: boolean;
  terminating: boolean;
  reply(request: SqliteWorkerRequest, value?: unknown): void;
  finishRetirement(): void;
};
const controls = vi.hoisted(() => ({
  workers: [] as ControlledWorker[],
  posted: vi.fn<(request: SqliteWorkerRequest) => void>(),
  acquire:
    vi.fn<typeof import("./state-database-coordinator.js").acquireStateDatabaseCoordinator>(),
  delegate:
    vi.fn<typeof import("./state-database-coordinator.js").tryCreateStateLifecycleDelegate>(),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  const { createDeferredCore: deferred } = await import("../shared/deferred.js");
  return {
    ...actual,
    Worker: class extends EventEmitter implements ControlledWorker {
      pending = new Map<number, SqliteWorkerRequest>();
      holdRetirement = false;
      terminating = false;
      private retirement = deferred<number>();
      private exited = false;
      constructor() {
        super();
        controls.workers.push(this);
      }
      ref() {}
      unref() {}
      postMessage(request: SqliteWorkerRequest) {
        controls.posted(request);
        this.pending.set(request.id, request);
        if (request.type === "open" || request.type === "close") {
          queueMicrotask(() => this.reply(request));
        }
      }
      reply(request: SqliteWorkerRequest, value?: unknown) {
        this.pending.delete(request.id);
        this.emit("message", { id: request.id, ok: true, value: serialize(value) });
      }
      terminate() {
        this.terminating = true;
        this.pending.clear();
        if (!this.holdRetirement) {
          queueMicrotask(() => this.finishRetirement());
        }
        return this.retirement.promise;
      }
      finishRetirement() {
        if (this.exited) {
          return;
        }
        this.exited = true;
        this.emit("exit", 0);
        this.retirement.resolve(0);
      }
    },
  };
});
vi.mock("./runtime-worker-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-worker-url.js")>()),
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/sqlite.worker.js"),
}));
vi.mock("./bun-sqlite-library.js", () => ({ ensureSqliteLibrarySelected: vi.fn() }));
vi.mock("./sqlite-worker-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-worker-identity.js")>()),
  readDatabasePathIdentity: async (databasePath: string) => ({
    key: "file:synthetic:state",
    canonicalPath: databasePath,
  }),
}));
vi.mock("./sqlite-worker-broker-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-worker-broker-admission.js")>()),
  resolveSqliteWorkerModuleUrl: async (url: URL) => ({
    modulePath: url.pathname,
    moduleUrl: url.href,
  }),
}));
vi.mock("./state-database-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state-database-coordinator.js")>()),
  acquireStateDatabaseCoordinator: controls.acquire,
  tryCreateStateLifecycleDelegate: controls.delegate,
  tryCreateGatewaySchemaFenceDelegate: () => undefined,
}));

const context: SqliteWorkerStateContext = {
  environment: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  coordinatorRuntime: { directory: "/synthetic/captured-locks", keepAlive: false },
};
type Operations = { sync: { input: undefined; output: string } };
const command = { type: "sync", input: undefined } as const;
const databasePath = path.resolve("/synthetic/state/openclaw.db");
let brokers: SqliteWorkerBroker[];
let channels: MessageChannel[];
let temporaryHeld: boolean;
let failDelegateRelease: boolean;
let liveDelegates: Set<NonNullable<ReturnType<typeof controls.delegate>>>;

beforeEach(() => {
  brokers = [];
  channels = [];
  temporaryHeld = false;
  failDelegateRelease = false;
  liveDelegates = new Set();
  controls.workers.length = 0;
  controls.posted.mockReset();
  controls.acquire.mockReset().mockImplementation(() => {
    expect(captureStateDatabaseCoordinatorRuntime()).toEqual(context.coordinatorRuntime);
    temporaryHeld = true;
    return {
      path: "/synthetic/captured-locks/state-lifecycle",
      get closed(): boolean {
        return !temporaryHeld;
      },
      release() {
        temporaryHeld = false;
      },
    };
  });
  controls.delegate.mockReset().mockImplementation(() => {
    if (!temporaryHeld) {
      return undefined;
    }
    expect(captureStateDatabaseCoordinatorRuntime()).toEqual(context.coordinatorRuntime);
    const channel = new MessageChannel();
    channels.push(channel);
    const delegate = {
      port: channel.port2,
      get closed(): boolean {
        return !liveDelegates.has(delegate);
      },
      release() {
        if (failDelegateRelease) {
          throw new Error("synthetic delegate cleanup failed");
        }
        liveDelegates.delete(delegate);
        channel.port1.close();
        channel.port2.close();
      },
    };
    liveDelegates.add(delegate);
    return delegate;
  });
});

afterEach(async () => {
  failDelegateRelease = false;
  for (const worker of controls.workers) {
    worker.holdRetirement = false;
    if (worker.terminating) {
      worker.finishRetirement();
    } else {
      // Replying may dispatch another queued job; drain only the captured requests.
      const pending = [...worker.pending.values()];
      for (const request of pending) {
        worker.reply(request);
      }
    }
  }
  try {
    await Promise.all(brokers.map((broker) => broker.close()));
  } finally {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    vi.restoreAllMocks();
  }
});

async function open(stateContext: SqliteWorkerStateContext | null = context) {
  const broker = new SqliteWorkerBroker();
  brokers.push(broker);
  const store = expectDefined(
    await broker.open<Operations>(
      {
        databasePath,
        moduleUrl: new URL("file:///synthetic/backend.js"),
        input: undefined,
      },
      stateContext ?? undefined,
    ),
    "synthetic store",
  );
  const worker = expectDefined(controls.workers.at(-1), "controlled worker");
  expect(controls.acquire).not.toHaveBeenCalled();
  expect(liveDelegates.size).toBe(0);
  return { broker, store, worker };
}

function admission() {
  const settlements: SqliteWorkerOperationSettlement[] = [];
  const factory = vi.fn<SqliteWorkerAdmissionFactory>(({ settled }) => {
    expect(temporaryHeld).toBe(false);
    expect(liveDelegates.size).toBe(1);
    void settled.then((value) => settlements.push(value));
    return {
      nativeLocations: [databasePath],
      admission: createSqliteWorkerOperationAdmission(() => {}),
    };
  });
  return { factory, settlements };
}

function executing(worker: ControlledWorker) {
  return expectDefined(
    [...worker.pending.values()].find((request) => request.type === "execute"),
    "dispatched command",
  );
}

describe("required SQLite worker lifecycle custody", () => {
  it("acquires under the captured runtime before admission and dispatch on an already open actor", async () => {
    const { broker, store, worker } = await open();
    const { factory, settlements } = admission();
    controls.posted.mockImplementation((request) => {
      if (request.type === "execute") {
        expect(factory).toHaveBeenCalledOnce();
        expect(liveDelegates.size).toBe(1);
        expect(request.stateLifecycle).toBe([...liveDelegates][0]?.port);
      }
    });
    const result = withStateDatabaseCoordinatorRuntimeDirectory("/synthetic/other-locks", () =>
      broker.runOperation(
        store,
        (scope) => scope.execute(command),
        context,
        undefined,
        factory,
        true,
      ),
    );
    expect(controls.acquire).toHaveBeenCalledWith({ databasePath });
    expect(temporaryHeld).toBe(false);
    expect(liveDelegates.size).toBe(1);
    worker.reply(executing(worker), "synced");
    await expect(result).resolves.toBe("synced");
    expect(settlements).toEqual([{ kind: "completed" }]);
    expect(liveDelegates.size).toBe(0);
  });

  it("leaves ordinary commands unbound when the host does not already hold a coordinator", async () => {
    const { broker, store, worker } = await open();
    const result = broker.runOperation(store, (scope) => scope.execute(command), context);
    const request = executing(worker);
    expect(request.stateLifecycle).toBeUndefined();
    expect(controls.acquire).not.toHaveBeenCalled();
    worker.reply(request, "ordinary");
    await expect(result).resolves.toBe("ordinary");
  });

  it("refuses a changed captured runtime before acquiring custody or creating admission", async () => {
    const { broker, store, worker } = await open();
    const { factory } = admission();
    await expect(
      broker.runOperation(
        store,
        (scope) => scope.execute(command),
        { ...context, coordinatorRuntime: { directory: "/synthetic/successor", keepAlive: false } },
        undefined,
        factory,
        true,
      ),
    ).rejects.toThrow("coordinator scope changed");
    expect(controls.acquire).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(worker.pending.size).toBe(0);
  });

  it("refuses required custody without a captured state owner", async () => {
    const { broker, store, worker } = await open(null);
    const { factory } = admission();
    await expect(
      broker.runOperation(
        store,
        (scope) => scope.execute(command),
        undefined,
        undefined,
        factory,
        true,
      ),
    ).rejects.toThrow("requires its captured state owner");
    expect(controls.acquire).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(worker.pending.size).toBe(0);
  });

  it("refuses dispatch if acquisition cannot produce the required delegate", async () => {
    const { broker, store, worker } = await open();
    const { factory } = admission();
    controls.delegate.mockReturnValue(undefined);
    await expect(
      broker.runOperation(
        store,
        (scope) => scope.execute(command),
        context,
        undefined,
        factory,
        true,
      ),
    ).rejects.toThrow("did not retain its required lifecycle custody");
    expect(controls.acquire).toHaveBeenCalledOnce();
    expect(temporaryHeld).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(worker.pending.size).toBe(0);
  });

  it("revalidates the owner after acquiring the temporary reference and releases it on refusal", async () => {
    const { broker, store, worker } = await open();
    const { factory } = admission();
    const revoked = new Error("owner retired during custody acquisition");
    await expect(
      broker.runOperation(
        store,
        (scope) => scope.execute(command),
        context,
        () => {
          if (temporaryHeld) {
            throw revoked;
          }
        },
        factory,
        true,
      ),
    ).rejects.toBe(revoked);
    expect(temporaryHeld).toBe(false);
    expect(liveDelegates.size).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(worker.pending.size).toBe(0);
  });

  it.each(["admission", "transport", "worker"] as const)(
    "retains custody until broker retirement settles a %s failure",
    async (failurePoint) => {
      const { broker, store, worker } = await open();
      worker.holdRetirement = true;
      const failure = new Error(`synthetic ${failurePoint} failure`);
      const settlement = createDeferredCore<SqliteWorkerOperationSettlement>();
      const factory: SqliteWorkerAdmissionFactory = (operation) => {
        void operation.settled.then(settlement.resolve);
        if (failurePoint === "admission") {
          throw failure;
        }
        return admission().factory(operation);
      };
      controls.posted.mockImplementation((request) => {
        if (request.type === "execute" && failurePoint === "transport") {
          throw failure;
        }
      });
      let finished = false;
      const result = broker
        .runOperation(store, (scope) => scope.execute(command), context, undefined, factory, true)
        .catch((error: unknown) => {
          finished = true;
          return error;
        });
      if (failurePoint === "worker") {
        worker.emit("error", failure);
      }
      expect(worker.terminating).toBe(true);
      expect(liveDelegates.size).toBe(1);
      await Promise.resolve();
      expect(finished).toBe(false);
      worker.finishRetirement();
      expect(await result).toBeInstanceOf(Error);
      await expect(settlement.promise).resolves.toMatchObject({
        kind: failurePoint === "admission" ? "not-entered" : "unknown",
        error: failure,
      });
      expect(liveDelegates.size).toBe(0);
      await expect(store.close()).rejects.toBeInstanceOf(Error);
    },
  );

  it("cancels a queued required command without acquiring custody or creating admission", async () => {
    const { broker, store, worker } = await open();
    const first = store.execute(command);
    const firstRequest = executing(worker);
    const controller = new AbortController();
    const { factory } = admission();
    const canceled = new Error("queued command canceled");
    const queued = broker.runOperation(
      store,
      (scope) => scope.execute(command, { signal: controller.signal }),
      context,
      undefined,
      factory,
      true,
    );
    controller.abort(canceled);
    await expect(queued).rejects.toBe(canceled);
    expect(controls.acquire).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    worker.reply(firstRequest, "first");
    await expect(first).resolves.toBe("first");
    expect(worker.pending.size).toBe(0);
  });

  it("retains a dispatched canceled command until its native result settles", async () => {
    const { broker, store, worker } = await open();
    const controller = new AbortController();
    const { factory, settlements } = admission();
    let finished = false;
    const result = broker
      .runOperation(
        store,
        (scope) => scope.execute(command, { signal: controller.signal }),
        context,
        undefined,
        factory,
        true,
      )
      .then((value) => {
        finished = true;
        return value;
      });
    controller.abort(new Error("caller stopped waiting"));
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(liveDelegates.size).toBe(1);
    expect(settlements).toEqual([]);
    worker.reply(executing(worker), "committed");
    await expect(result).resolves.toBe("committed");
    expect(settlements).toEqual([{ kind: "completed" }]);
    expect(liveDelegates.size).toBe(0);
  });

  it("keeps failed delegate cleanup with the actor without changing a committed result", async () => {
    const { broker, store, worker } = await open();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { factory, settlements } = admission();
    const result = broker.runOperation(
      store,
      (scope) => scope.execute(command),
      context,
      undefined,
      factory,
      true,
    );
    failDelegateRelease = true;
    worker.reply(executing(worker), "committed");
    await expect(result).resolves.toBe("committed");
    expect(settlements).toEqual([{ kind: "completed" }]);
    expect(warning).toHaveBeenCalledOnce();
    expect(liveDelegates.size).toBe(1);
    expect(broker.isAvailable(store)).toBe(false);
    failDelegateRelease = false;
    await store.close();
    expect(liveDelegates.size).toBe(0);
  });
});
