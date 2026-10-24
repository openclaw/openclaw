import { deserialize } from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { createSqliteWorkerClient } from "../infra/sqlite-worker-client.js";
import { createSqliteWorkerClientActor } from "../infra/sqlite-worker-client.test-support.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
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

function endSession(sessionId: string, endedAt = 1) {
  return { type: "capture.endSession" as const, input: { sessionId, endedAt } };
}

const physical = vi.hoisted(() => ({
  client: undefined as
    | ReturnType<typeof createSqliteWorkerClient<OpenClawStateWorkerOperations>>
    | undefined,
  events: [] as unknown[],
  beforeDispatch: undefined as (() => void) | undefined,
  commandCompletion: undefined as Promise<void> | undefined,
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

// mock-isolation: the synthetic physical database must not reach the real cache singleton lifecycle.
vi.mock("./openclaw-state-db-cache.js", () => ({
  assertPublishedOpenClawStateDatabaseLifecycle: () => {},
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

let fixture: ReturnType<typeof createLeaseFixture>;
beforeEach(() => {
  fixture = createLeaseFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  fixture.releaseGates();
  await fixture.close();
  await getOpenClawStateWorkerOwner().close();
  vi.useRealTimers();
  physical.client = undefined;
  physical.events = [];
  physical.beforeDispatch = undefined;
  physical.commandCompletion = undefined;
  physical.openGate = undefined;
  physical.onOpen = undefined;
  physical.databaseAdmission = undefined;
});

function createLeaseFixture() {
  const gates: Deferred[] = [];
  const defer = () => {
    const gate = createDeferredCore();
    gates.push(gate);
    return gate;
  };
  const openGate = defer();
  const actor = createSqliteWorkerClientActor();
  physical.client = createSqliteWorkerClient<OpenClawStateWorkerOperations>({
    actor,
    isDraining: () => false,
    isAvailable: () => true,
    dispatch: async (payload, _signal, _scope, assertCurrent) => {
      physical.beforeDispatch?.();
      assertCurrent?.();
      const command: unknown = deserialize(payload);
      physical.events.push(command);
      await physical.commandCompletion;
    },
    release: async () => {
      physical.events.push("physical-close");
    },
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const context: OpenClawStateWorkerContext = {
    maintenanceScope: maintenance,
    admission: {
      coordinationKey: actor.key,
      databasePath: actor.databasePath,
      identity: { key: actor.key, canonicalPath: actor.databasePath },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
  physical.databaseAdmission = context.admission;
  return {
    maintenance,
    context,
    openGate,
    defer,
    releaseGates: () => {
      for (const gate of gates) {
        gate.resolve();
      }
    },
    pauseOpen: () => {
      physical.openGate = openGate.promise;
    },
    lease: (finalize?: (scope: DomainScope) => Promise<void>) =>
      maintenance.run(() => createOpenClawStateWorkerLease(context, finalize)),
    async close(...pending: Promise<unknown>[]) {
      openGate.resolve();
      await Promise.allSettled(pending);
      await maintenance.close();
    },
  };
}

it("closes fresh callback admission while accepted callbacks and terminal writes finish", async () => {
  const { maintenance } = fixture;
  const acceptedCommand = endSession("accepted");
  const terminalCommand = endSession("terminal", 2);
  const forbiddenCommand = endSession("not-admitted", 3);
  const finishAccepted = fixture.defer();
  const acceptedFinished = fixture.defer();
  const pendingCommand = fixture.defer();
  const lease = fixture.lease(async (terminal) => {
    physical.events.push("finalize-start");
    finishAccepted.resolve();
    await acceptedFinished.promise;
    await terminal.execute(terminalCommand);
    physical.events.push("finalize-end");
  });
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
  await expect(lease.runOperation(lateCallback)).rejects.toThrow(
    "Database maintenance resource admission is closed",
  );
  expect(lateCallback).not.toHaveBeenCalled();
  expect(physical.events).toEqual([]);
  pendingCommand.resolve();
  await fixture.close(closed, accepted);
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
  fixture.pauseOpen();
  const { maintenance, openGate } = fixture;
  const commandStarted = fixture.defer();
  const finishCommand = fixture.defer();
  physical.beforeDispatch = commandStarted.resolve;
  const lease = fixture.lease();
  const callbackResult = createDeferredCore<string>();
  const acceptedCommand = endSession("accepted-before-open");
  physical.commandCompletion = finishCommand.promise.then(() => {
    expect(physical.events).toEqual([acceptedCommand]);
  });
  let invocation: DomainScope | undefined;
  const commands: Promise<void>[] = [];
  const operation = lease.runOperation((scope) => {
    invocation = scope;
    commands.push(scope.execute(acceptedCommand));
    return callbackResult.promise;
  });
  const settled = vi.fn();
  void operation.then(settled, settled);
  callbackResult.resolve("callback-complete");
  await callbackResult.promise;
  const closing = maintenance.close();

  if (!invocation) {
    throw new Error("Lease callback was not invoked synchronously");
  }
  await expect(invocation.execute(endSession("after-callback", 2))).rejects.toThrow(
    "Shared-state worker operation is closed",
  );
  expect(settled).not.toHaveBeenCalled();
  expect(physical.events).toEqual([]);

  openGate.resolve();
  await lease.ready;
  await commandStarted.promise;
  expect(settled).not.toHaveBeenCalled();
  expect(physical.events).toEqual([acceptedCommand]);
  finishCommand.resolve();
  await expect(commands[0]).resolves.toBeUndefined();
  await expect(operation).resolves.toBe("callback-complete");
  await fixture.close(operation, ...commands, closing);
  expect(physical.events).toEqual([acceptedCommand, "physical-close"]);
});

it("cancels a queued callback without abandoning the shared actor's cold acquisition", async ({
  signal,
}) => {
  fixture.pauseOpen();
  const lease = fixture.lease();
  const canceled = new AbortController();
  const pending = lease.execute(endSession("canceled-before-open"), { signal: canceled.signal });
  const reason = new Error("callback task deadline expired");
  canceled.abort(reason);
  await withinTest(
    expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason }),
    signal,
  );
  expect(physical.events).toEqual([]);
  await fixture.close(pending, lease.ready);
  expect(physical.events).toEqual(["physical-close"]);
});

it.for([
  { kind: "raw Error abort", reason: new Error("canceled"), abort: true, persistent: false },
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
    fixture.pauseOpen();
    const { maintenance, context, openGate } = fixture;
    const opens = vi.fn();
    physical.onOpen = opens;
    const owner = getOpenClawStateWorkerOwner();
    const canceled = new AbortController();
    const first = maintenance.run(() => owner.open(context, { signal: canceled.signal }));
    const surviving = maintenance.run(() => owner.open(context));
    const failure = new Error("shared physical failure");
    const firstRejected = expect(first).rejects.toBe(persistent ? failure : reason);
    const survivingOutcome = persistent
      ? expect(surviving).rejects.toBe(failure)
      : expect(surviving).resolves.toBe(physical.client!.store);
    if (abort) {
      canceled.abort(reason);
    }
    if (persistent) {
      openGate.reject(failure);
    } else {
      openGate.resolve();
    }
    await withinTest(Promise.all([firstRejected, survivingOutcome]), signal);
    expect(opens).toHaveBeenCalledOnce();
    await fixture.close(first, surviving);
    expect(physical.events).toEqual(persistent ? [] : ["physical-close"]);
  },
);

it("retires an abandoned actor after joining its accepted native opening", async ({ signal }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fixture.pauseOpen();
  const { context, openGate } = fixture;
  const owner = getOpenClawStateWorkerOwner();
  const opening = fixture.defer();
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
  const settled = vi.fn();
  void pending.then(settled, settled);
  try {
    await withinTest(opening.promise, signal);
    cancel.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    openGate.resolve();
    await withinTest(rejected, signal);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(physical.events).toContain("physical-close");
  } finally {
    openGate.resolve();
    await Promise.allSettled([pending]);
    await owner.close();
  }
});

it.each(["replaced", "revoked"] as const)(
  "refuses a finite command when its resource claim is %s before dispatch",
  async (change) => {
    const { maintenance } = fixture;
    const lease = fixture.lease();
    await lease.ready;
    let revoked = false;
    vi.spyOn(maintenance, "assertOwnerCurrent").mockImplementation(() => {
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
        maintenance.own(lease, "shared-resources", () => lease.release());
      }
    };
    await expect(lease.execute(endSession("refused"))).rejects.toThrow(
      change === "revoked" ? "Synthetic maintenance owner revoked" : "resource owner changed",
    );
    expect(physical.events).toEqual([]);
  },
);
