import { performance } from "node:perf_hooks";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import type { Actor } from "../infra/sqlite-worker-broker.types.js";
import { createSqliteWorkerClient } from "../infra/sqlite-worker-client.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
  runOutsideOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";
import { getOpenClawStateWorkerOwner } from "./openclaw-state-worker-owner.js";
import {
  createOpenClawStateWorkerLease,
  runOpenClawStateWorkerOperation,
} from "./openclaw-state-worker-store.js";

type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;

const physical = vi.hoisted(() => ({
  client: undefined as
    | ReturnType<typeof createSqliteWorkerClient<OpenClawStateWorkerOperations>>
    | undefined,
  events: [] as unknown[],
  beforeDispatch: undefined as (() => void) | undefined,
  openGate: undefined as Promise<void> | undefined,
  onOpen: undefined as (() => void) | undefined,
  databaseAdmission: undefined as OpenClawStateWorkerContext["admission"] | undefined,
  ownerKey: Symbol("synthetic-shared-worker-owner"),
}));

vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      const [key, ...rest] = args;
      return actual.resolveGlobalSingleton(
        key === Symbol.for("openclaw.sharedStateWorkerOwner") ? physical.ownerKey : key,
        ...rest,
      );
    },
  };
});

vi.mock("./openclaw-state-db-cache.js", () => ({
  openClawStateDatabaseCache: {
    getKnownOpenClawStateDatabaseIdentity: () => physical.databaseAdmission?.identity,
  },
  captureOpenClawStateDatabaseReadAdmission: () => {
    if (!physical.databaseAdmission) {
      throw new Error("Synthetic database admission is not initialized");
    }
    return physical.databaseAdmission;
  },
  getOpenClawStateDatabaseTerminalFailureAsync: async () => undefined,
  publishOpenClawStateDatabaseWorkerAdmission: () => {},
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
  registerOpenClawStateDatabaseLifecycleListener: () => () => {},
}));

vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state-worker.js"),
}));

vi.mock("../infra/sqlite-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-worker-store.js")>();
  const { runSqliteWorkerClientOperation } = await import("../infra/sqlite-worker-client.js");
  const current = () => {
    if (!physical.client) {
      throw new Error("Synthetic worker client is not initialized");
    }
    return physical.client;
  };
  return {
    ...actual,
    openSharedStateSqliteWorkerStore: async () => {
      physical.onOpen?.();
      await physical.openGate;
      return current().store;
    },
    closeUnclaimedSharedStateSqliteWorkers: async () => {},
    hasUnclaimedSharedStateSqliteCleanup: () => false,
    isSqliteWorkerStoreAvailable: () => current().client.isAvailable(),
    getSqliteWorkerActorIdentity: () => current().client.actor,
    retireSqliteWorkerActor: async () => current().store.close(),
    runSqliteWorkerStoreOperation: <T>(
      store: SqliteWorkerStore<OpenClawStateWorkerOperations>,
      operation: (scope: DomainScope) => Promise<T>,
      context: OpenClawStateWorkerContext,
      assertCurrent: () => void,
    ) => {
      expect(store).toBe(current().store);
      return runSqliteWorkerClientOperation(
        current().client,
        operation,
        context,
        () => () => {},
        assertCurrent,
      );
    },
  };
});

afterEach(() => {
  physical.client = undefined;
  physical.events = [];
  physical.beforeDispatch = undefined;
  physical.openGate = undefined;
  physical.onOpen = undefined;
  physical.databaseAdmission = undefined;
});

function createLeaseFixture() {
  const actor: Actor = {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "synthetic-state",
    databasePath: "/synthetic/state.sqlite",
    pathReferences: new Map([["/synthetic/state.sqlite", 1]]),
    moduleUrl: "file:///synthetic/shared-state-worker.js",
    inputHash: "capture-lease-fixture",
    get slot(): never {
      throw new Error("Lease client must not access the native Worker slot");
    },
    references: 1,
    opened: Promise.resolve(),
    openDispatch: { dispatched: true },
    initialized: true,
    backendClosed: false,
  };
  physical.client = createSqliteWorkerClient<OpenClawStateWorkerOperations>({
    actor,
    isDraining: () => false,
    isAvailable: () => true,
    dispatch: async (payload, _signal, _scope, assertCurrent) => {
      physical.beforeDispatch?.();
      assertCurrent?.();
      const command: unknown = deserialize(payload);
      physical.events.push(command);
      return isRecord(command) && command.type === "database.inspectIdle" ? "healthy" : undefined;
    },
    release: async () => {
      physical.events.push("physical-close");
    },
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const context: OpenClawStateWorkerContext = {
    maintenanceScope: maintenance,
    admission: {
      coordinationKey: "synthetic-state",
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
  physical.databaseAdmission = context.admission;
  return { maintenance, context };
}

it("closes fresh callback admission while accepted callbacks and terminal writes finish", async () => {
  const { maintenance, context } = createLeaseFixture();
  const acceptedCommand = {
    type: "capture.endSession" as const,
    input: { sessionId: "accepted", endedAt: 1 },
  };
  const terminalCommand = {
    type: "capture.endSession" as const,
    input: { sessionId: "terminal", endedAt: 2 },
  };
  const forbiddenCommand = {
    type: "capture.endSession" as const,
    input: { sessionId: "not-admitted", endedAt: 3 },
  };
  const finishAccepted = createDeferredCore();
  const acceptedFinished = createDeferredCore();
  const pendingCommand = createDeferredCore();
  const lease = maintenance.run(() =>
    createOpenClawStateWorkerLease(context, async (terminal) => {
      physical.events.push("finalize-start");
      finishAccepted.resolve();
      await acceptedFinished.promise;
      await terminal.execute(terminalCommand);
      physical.events.push("finalize-end");
    }),
  );
  await lease.ready;
  const accepted = lease.runOperation(async (operation) => {
    try {
      await finishAccepted.promise;
      await operation.execute(acceptedCommand);
      physical.events.push("accepted-complete");
    } finally {
      acceptedFinished.resolve();
    }
  });
  void maintenance.track(pendingCommand.promise);
  const closed = maintenance.close();
  const lateCallback = vi.fn(async (operation: DomainScope) => operation.execute(forbiddenCommand));
  try {
    await expect(lease.runOperation(lateCallback)).rejects.toThrow(
      "Database maintenance resource admission is closed",
    );
    expect(lateCallback).not.toHaveBeenCalled();
    expect(physical.events).toEqual([]);
  } finally {
    pendingCommand.resolve();
    await closed;
    await accepted;
  }
  expect(physical.events).toEqual([
    "finalize-start",
    acceptedCommand,
    "accepted-complete",
    terminalCommand,
    "finalize-end",
    "physical-close",
  ]);
});

it("drains a command accepted before cold acquisition after its callback returns", async () => {
  const openGate = createDeferredCore();
  physical.openGate = openGate.promise;
  const { maintenance, context } = createLeaseFixture();
  const lease = maintenance.run(() => createOpenClawStateWorkerLease(context));
  const callbackResult = createDeferredCore<string>();
  const acceptedCommand = {
    type: "capture.endSession" as const,
    input: { sessionId: "accepted-before-open", endedAt: 1 },
  };
  let invocation: DomainScope | undefined;
  const commands: Promise<void>[] = [];
  const operation = lease.runOperation((scope) => {
    invocation = scope;
    commands.push(scope.execute(acceptedCommand));
    return callbackResult.promise;
  });
  let operationSettled = false;
  const markSettled = () => {
    operationSettled = true;
  };
  void operation.then(markSettled, markSettled);
  callbackResult.resolve("callback-complete");
  await callbackResult.promise;

  try {
    if (!invocation) {
      throw new Error("Lease callback was not invoked synchronously");
    }
    await expect(
      invocation.execute({
        type: "capture.endSession",
        input: { sessionId: "after-callback", endedAt: 2 },
      }),
    ).rejects.toThrow("Shared-state worker operation is closed");
    expect(operationSettled).toBe(false);
    expect(physical.events).toEqual([]);

    openGate.resolve();
    await lease.ready;
    await expect(commands[0]).resolves.toBeUndefined();
    await expect(operation).resolves.toBe("callback-complete");
    expect(physical.events).toEqual([acceptedCommand]);
  } finally {
    openGate.resolve();
    await Promise.allSettled([operation, ...commands]);
    await maintenance.close();
  }
  expect(physical.events).toEqual([acceptedCommand, "physical-close"]);
});

it("cancels a queued callback without abandoning the shared actor's cold acquisition", async ({
  signal,
}) => {
  const openGate = createDeferredCore();
  physical.openGate = openGate.promise;
  const { maintenance, context } = createLeaseFixture();
  const lease = maintenance.run(() => createOpenClawStateWorkerLease(context));
  const canceled = new AbortController();
  const pending = lease.execute(
    { type: "capture.endSession", input: { sessionId: "canceled-before-open", endedAt: 1 } },
    { signal: canceled.signal },
  );
  const reason = new Error("callback task deadline expired");
  canceled.abort(reason);
  try {
    await withinTest(
      expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason }),
      signal,
    );
    expect(physical.events).toEqual([]);
  } finally {
    openGate.resolve();
    await Promise.allSettled([pending, lease.ready]);
    await maintenance.close();
  }
  expect(physical.events).toEqual(["physical-close"]);
});

it.for([
  { kind: "raw Error abort", reason: new Error("canceled"), abort: true, persistent: false },
  { kind: "normalized primitive abort", reason: "canceled", abort: true, persistent: false },
  { kind: "normalized object abort", reason: { canceled: true }, abort: true, persistent: false },
  { kind: "normalized null abort", reason: null, abort: true, persistent: false },
  { kind: "uncanceled physical failure", reason: undefined, abort: false, persistent: true },
  {
    kind: "canceled persistent physical failure",
    reason: "canceled",
    abort: true,
    persistent: true,
  },
])(
  "preserves independent opening ownership for $kind",
  async ({ reason, abort, persistent }, { signal }) => {
    const openGate = createDeferredCore();
    physical.openGate = openGate.promise;
    const opens = vi.fn();
    physical.onOpen = opens;
    const { maintenance, context } = createLeaseFixture();
    const owner = getOpenClawStateWorkerOwner();
    const canceled = new AbortController();
    const first = maintenance.run(() => owner.open(context, { signal: canceled.signal }));
    const surviving = maintenance.run(() => owner.open(context));
    const failure = persistent
      ? new Error("shared physical failure")
      : reason instanceof Error
        ? reason
        : new Error("normalized opening cancellation");
    const firstRejected = expect(first).rejects.toBe(failure);
    const survivingOutcome = persistent
      ? expect(surviving).rejects.toBe(failure)
      : expect(surviving).resolves.toBe(physical.client!.store);
    if (abort) {
      canceled.abort(reason);
    }
    if (!persistent) {
      physical.openGate = undefined;
    }
    openGate.reject(failure);
    try {
      await withinTest(Promise.all([firstRejected, survivingOutcome]), signal);
      expect(opens).toHaveBeenCalledTimes(abort ? 2 : 1);
    } finally {
      openGate.resolve();
      await Promise.allSettled([first, surviving]);
      await maintenance.close();
    }
    expect(physical.events).toEqual(persistent ? [] : ["physical-close"]);
  },
);

it("retires an abandoned actor after joining its accepted native opening", async ({ signal }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const { context, maintenance } = createLeaseFixture();
  const owner = getOpenClawStateWorkerOwner();
  const openGate = createDeferredCore();
  const opening = createDeferredCore();
  physical.openGate = openGate.promise;
  physical.onOpen = opening.resolve;
  const cancel = new AbortController();
  const reason = new Error("callback abandoned its accepted opening");
  const operation = vi.fn(async () => undefined);
  const pending = runOpenClawStateWorkerOperation(
    { ...context, maintenanceScope: undefined },
    operation,
    { signal: cancel.signal },
  );
  const rejected = expect(pending).rejects.toBe(reason);
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void pending.then(markSettled, markSettled);
  try {
    await withinTest(opening.promise, signal);
    cancel.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    openGate.resolve();
    await withinTest(rejected, signal);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(physical.events).toContain("physical-close");
  } finally {
    openGate.resolve();
    await Promise.allSettled([pending]);
    await owner.close();
    await maintenance.close();
    monotonicClock.mockRestore();
    vi.useRealTimers();
  }
});

it.each(["removed", "reassigned", "replaced", "revoked"] as const)(
  "refuses a finite command when its resource claim is %s before dispatch",
  async (change) => {
    const { maintenance, context } = createLeaseFixture();
    const successor = createOpenClawDatabaseMaintenanceScope();
    const lease = maintenance.run(() => createOpenClawStateWorkerLease(context));
    await lease.ready;
    let revoked = false;
    const assertOwner = vi.spyOn(maintenance, "assertOwnerCurrent").mockImplementation(() => {
      if (revoked) {
        throw new Error("Synthetic maintenance owner revoked");
      }
    });
    physical.beforeDispatch = () => {
      physical.beforeDispatch = undefined;
      if (change === "revoked") {
        revoked = true;
      } else {
        runOutsideOpenClawDatabaseMaintenanceScope(() =>
          observeOpenClawDatabaseMaintenanceResource(lease),
        );
        if (change !== "removed") {
          const owner = change === "replaced" ? maintenance : successor;
          owner.own(lease, "shared-resources", () => lease.release());
        }
      }
    };
    try {
      await expect(
        lease.execute({ type: "capture.endSession", input: { sessionId: "refused", endedAt: 1 } }),
      ).rejects.toThrow(
        change === "revoked" ? "Synthetic maintenance owner revoked" : "resource owner changed",
      );
      expect(physical.events).toEqual([]);
    } finally {
      assertOwner.mockRestore();
      await lease.release();
      await Promise.all([maintenance.close(), successor.close()]);
    }
  },
);
