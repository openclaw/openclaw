import { deserialize } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
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
import { createOpenClawStateWorkerLease } from "./openclaw-state-worker-store.js";

type DomainScope = Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">;

const physical = vi.hoisted(() => ({
  client: undefined as
    | ReturnType<typeof createSqliteWorkerClient<OpenClawStateWorkerOperations>>
    | undefined,
  events: [] as unknown[],
  beforeDispatch: undefined as (() => void) | undefined,
  openGate: undefined as Promise<void> | undefined,
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
  getOpenClawStateDatabaseTerminalFailureAsync: async () => undefined,
  publishOpenClawStateDatabaseWorkerAdmission: () => {},
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
  registerOpenClawStateDatabaseLifecycleListener: () => () => {},
}));

vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/shared-state-worker.js"),
}));

vi.mock("../infra/sqlite-worker-store.js", async () => {
  const { SqliteWorkerError } = await import("../infra/sqlite-worker-contract.js");
  const { runSqliteWorkerClientOperation } = await import("../infra/sqlite-worker-client.js");
  const current = () => {
    if (!physical.client) {
      throw new Error("Synthetic worker client is not initialized");
    }
    return physical.client;
  };
  return {
    SqliteWorkerError,
    openSharedStateSqliteWorkerStore: async () => {
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
});

function createLeaseFixture() {
  const actor: Actor = {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "capture-lease-fixture",
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
      physical.events.push(deserialize(payload));
    },
    release: async () => {
      physical.events.push("physical-close");
    },
  });
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const context: OpenClawStateWorkerContext = {
    maintenanceScope: maintenance,
    admission: {
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: () => {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
  return { maintenance, context };
}

it.each(["execute", "runOperation"] as const)(
  "closes fresh %s admission while accepted callbacks and terminal writes finish",
  async (entry) => {
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
    const lateCallback = vi.fn(async (operation: DomainScope) =>
      operation.execute(forbiddenCommand),
    );
    try {
      const late =
        entry === "execute" ? lease.execute(forbiddenCommand) : lease.runOperation(lateCallback);
      await expect(late).rejects.toThrow("Database maintenance resource admission is closed");
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
  },
);

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
