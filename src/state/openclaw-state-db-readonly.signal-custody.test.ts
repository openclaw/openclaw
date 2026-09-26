import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  adoptPreparedLocation,
  cleanupSnapshotOperations,
} from "../infra/sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const mocks = vi.hoisted(() => ({
  source: "/synthetic/state/source.sqlite",
  directory: "/synthetic/state/snapshot",
  resources: new Set<OpenClawStateDatabaseAsyncResource>(),
  removed: [] as string[],
  events: [] as string[],
  prepare:
    vi.fn<
      (
        pathname: string,
        options?: { signal?: AbortSignal; preserveSourceArtifacts?: boolean },
      ) => Promise<PreparedSqliteReadOnlyLocation>
    >(),
  removeAsync: vi.fn<(file: string) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  read: vi.fn<
    (
      source: OpenClawStateReadLocation,
      authority: OpenClawStateReadAuthority,
    ) => Promise<OpenClawStateReadOutcome>
  >(),
  forbidden: vi.fn(() => {
    throw new Error("This controlled custody test must not open SQLite or start a worker");
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const remove = (file: string) => {
    mocks.removed.push(file);
    mocks.events.push("remove");
  };
  return {
    ...actual,
    statSync: () => ({}),
    default: {
      ...actual,
      existsSync: () => false,
      rmSync: remove,
      promises: { ...actual.promises, rm: mocks.removeAsync },
    },
  };
});
vi.mock("../cli/signal-exit-barrier.js", () => ({ registerSignalExitFinalizer: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ getChildLogger: () => ({ warn: vi.fn() }) }));
vi.mock("./openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    identity: { key: databasePath, canonicalPath: databasePath },
    assertCurrent() {},
  }),
  registerOpenClawStateDatabaseAsyncResource: (resource: OpenClawStateDatabaseAsyncResource) => {
    mocks.resources.add(resource);
    return () => mocks.resources.delete(resource);
  },
  borrowOpenClawStateDatabaseForAsyncRead: () => undefined,
  retainOpenClawStateDatabaseForIndependentRead: () => undefined,
  openClawStateDatabaseCache: {
    getCachedOpenClawStateDatabase: () => undefined,
    assertOpenClawStateDatabaseOpenAllowed() {},
    assertOpenClawStateDatabaseFreshOpenAllowedAtPath() {},
  },
}));
vi.mock("./openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadWorkerContext: ({
    path,
  }: {
    path: string;
  }): OpenClawStateWorkerContext => ({
    admission: {
      databasePath: path,
      identity: { key: path, canonicalPath: path },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  }),
}));

vi.mock("../infra/sqlite-snapshot-source.js", () => ({
  prepareSqliteReadOnlyLocation: mocks.prepare,
  prepareSqliteReadOnlyLocationAsync: mocks.prepare,
  prepareSqliteReadOnlyLocationSync: mocks.forbidden,
}));
vi.mock("../infra/sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyLocationFromOwnedDatabase: mocks.forbidden,
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.forbidden,
  requireNodeSqlite: mocks.forbidden,
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  openOpenClawStateReadOnlyLocation: mocks.forbidden,
  withOpenClawStateReadOnlyLocation: mocks.forbidden,
}));
vi.mock("./openclaw-state-db-schema-version.js", () => ({
  assertSupportedStateSchemaVersion: mocks.forbidden,
}));
vi.mock("./openclaw-state-read-worker.js", () => ({
  createOpenClawStateReadTransport: () => ({
    validateFresh: async () => {},
    read: mocks.read,
    close: mocks.close,
  }),
}));

let exitCleanup: (() => void) | undefined;
let restoreExitSpy: () => void;
beforeAll(() => {
  const original = process.once.bind(process);
  const spy = vi.spyOn(process, "once").mockImplementation(function (event, listener) {
    if (event === "exit") {
      exitCleanup = () => listener(0);
      return process;
    }
    return original(event, listener);
  });
  restoreExitSpy = () => spy.mockRestore();
});
afterAll(() => restoreExitSpy());

beforeEach(() => {
  mocks.removed.length = 0;
  mocks.events.length = 0;
  mocks.forbidden.mockClear();
  mocks.removeAsync.mockReset().mockImplementation(async (file) => {
    mocks.removed.push(file);
    mocks.events.push("remove");
  });
  mocks.prepare
    .mockReset()
    .mockImplementation(async () =>
      adoptPreparedLocation(`${mocks.directory}/database.sqlite`, mocks.directory),
    );
  mocks.close.mockReset().mockResolvedValue();
  mocks.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] },
  });
});

afterEach(async () => {
  mocks.close.mockResolvedValue();
  for (const resource of mocks.resources) {
    await resource.close();
  }
  await cleanupSnapshotOperations();
  expect(mocks.resources.size).toBe(0);
  expect(mocks.forbidden).not.toHaveBeenCalled();
});

function runDirectRead() {
  return withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead({ path: mocks.source }, { type: "fleet.list" }),
  );
}

function captureOutcome(operation: Promise<unknown>) {
  return operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function assertFilesRetained() {
  expect(mocks.removed).toEqual([]);
  expect(exitCleanup).toBeTypeOf("function");
  exitCleanup?.();
  expect(mocks.removed).toEqual([]);
}

it.each(["direct", "snapshot"] as const)(
  "joins a pending %s preparation handoff before removing its directory",
  async (kind) => {
    const preparing = createDeferredCore();
    const finishPreparation = createDeferredCore<PreparedSqliteReadOnlyLocation>();
    const prepared = adoptPreparedLocation(`${mocks.directory}/database.sqlite`, mocks.directory);
    mocks.prepare.mockImplementation(() => {
      preparing.resolve();
      return finishPreparation.promise;
    });
    const operation = captureOutcome(
      kind === "direct"
        ? runDirectRead()
        : withOpenClawStateDatabaseReadSnapshot(async () => "complete", { path: mocks.source }),
    );
    await preparing.promise;
    const cleanup = cleanupSnapshotOperations();
    try {
      assertFilesRetained();
    } finally {
      finishPreparation.resolve(prepared);
      await operation;
      await cleanup;
    }
    expect(mocks.removed).toEqual([mocks.directory]);
    expect(mocks.read).not.toHaveBeenCalled();
  },
);

it("joins the direct reader and its transport close before deleting prepared bytes", async () => {
  const reading = createDeferredCore();
  const finishRead = createDeferredCore();
  const closing = createDeferredCore();
  const finishClose = createDeferredCore();
  mocks.read.mockImplementation(async () => {
    reading.resolve();
    await finishRead.promise;
    mocks.events.push("read-settled");
    return { value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] } };
  });
  mocks.close.mockImplementation(async () => {
    closing.resolve();
    await finishClose.promise;
    mocks.events.push("close-settled");
  });
  const operation = captureOutcome(runDirectRead());
  await reading.promise;
  const cleanup = cleanupSnapshotOperations();
  try {
    assertFilesRetained();
    finishRead.resolve();
    await closing.promise;
    assertFilesRetained();
  } finally {
    finishRead.resolve();
    finishClose.resolve();
    await operation;
    await cleanup;
  }
  expect(mocks.events).toEqual(["read-settled", "close-settled", "remove"]);
});

it("retains an enclosing snapshot callback while cleanup closes new read admission", async () => {
  const entered = createDeferredCore();
  const finishCallback = createDeferredCore();
  let escaped!: ReturnType<typeof AsyncLocalStorage.snapshot>;
  const operation = captureOutcome(
    withOpenClawStateDatabaseReadSnapshot(
      async () => {
        escaped = AsyncLocalStorage.snapshot();
        entered.resolve();
        await finishCallback.promise;
        mocks.events.push("callback-settled");
      },
      { path: mocks.source },
    ),
  );
  await entered.promise;
  const cleanup = cleanupSnapshotOperations();
  try {
    assertFilesRetained();
    const rejected = await escaped(() =>
      captureOutcome(
        Promise.resolve().then(() =>
          executeExistingOpenClawStateRead({ path: mocks.source }, { type: "fleet.list" }),
        ),
      ),
    );
    expect(
      "error" in rejected && isStateDatabaseReadAdmissionInvalidatedError(rejected.error),
    ).toBe(true);
    expect(mocks.read).not.toHaveBeenCalled();
  } finally {
    finishCallback.resolve();
    await operation;
    await cleanup;
  }
  expect(mocks.events).toEqual(["callback-settled", "remove"]);
});

it("retains failed-close custody through both cleanup paths until the same reader closes", async () => {
  const failure = new Error("Controlled transport close rejection");
  mocks.close.mockRejectedValue(failure);
  const operation = await captureOutcome(runDirectRead());
  expect(operation).toEqual({ error: failure });
  expect(mocks.resources.size).toBe(1);
  const [resource] = mocks.resources;
  try {
    await cleanupSnapshotOperations();
    assertFilesRetained();
  } finally {
    mocks.close.mockResolvedValue();
    await resource?.close();
    await cleanupSnapshotOperations();
  }
  expect(mocks.resources.size).toBe(0);
  expect(mocks.removed).toEqual([mocks.directory]);
});

it.each(["registered", "not-yet-registered"] as const)(
  "joins preparation admitted during removal when its directory is %s",
  async (registration) => {
    const initialDirectory = "/synthetic/state/initial-snapshot";
    const removingInitial = createDeferredCore();
    const finishInitialRemoval = createDeferredCore();
    const preparing = createDeferredCore();
    const stopped = createDeferredCore();
    const finishPreparation = createDeferredCore<PreparedSqliteReadOnlyLocation>();
    let prepared: PreparedSqliteReadOnlyLocation | undefined;
    let preparationSignal: AbortSignal | undefined;
    const prepareLocation = () =>
      (prepared ??= adoptPreparedLocation(`${mocks.directory}/database.sqlite`, mocks.directory));
    mocks.removeAsync.mockImplementation(async (file) => {
      if (file === initialDirectory) {
        removingInitial.resolve();
        await finishInitialRemoval.promise;
      }
      mocks.removed.push(file);
      mocks.events.push("remove");
    });
    mocks.prepare.mockImplementation((_pathname, options) => {
      if (registration === "registered") {
        prepareLocation();
      }
      preparationSignal = options?.signal;
      preparationSignal?.addEventListener("abort", () => stopped.resolve(), { once: true });
      preparing.resolve();
      return finishPreparation.promise;
    });
    adoptPreparedLocation(`${initialDirectory}/database.sqlite`, initialDirectory);
    const cleanup = cleanupSnapshotOperations();
    await removingInitial.promise;
    const operation = captureOutcome(runDirectRead());
    await preparing.promise;
    try {
      expect(preparationSignal).toBeDefined();
      finishInitialRemoval.resolve();
      const progress = await Promise.race([
        stopped.promise.then(() => "late-work-stopped"),
        cleanup.then(() => "cleanup-returned"),
      ]);
      expect(mocks.removed).toEqual([initialDirectory]);
      expect(progress).toBe("late-work-stopped");
    } finally {
      finishInitialRemoval.resolve();
      finishPreparation.resolve(prepareLocation());
      await operation;
      await cleanup;
    }
    expect(mocks.removed).toEqual([initialDirectory, mocks.directory]);
    expect(mocks.read).not.toHaveBeenCalled();
  },
);

it("forwards caller cancellation while retaining descendants and transport close", async () => {
  const caller = new AsyncWorkScope();
  const reason = new Error("Controlled caller cancellation");
  const entered = createDeferredCore();
  const reading = createDeferredCore();
  const closing = createDeferredCore();
  const finishCallback = createDeferredCore();
  const finishDescendant = createDeferredCore();
  const finishRead = createDeferredCore();
  const finishClose = createDeferredCore();
  let observedSignal: AbortSignal | undefined;
  let abortListenerSignal: AbortSignal | undefined;
  let descendant: Promise<void> | undefined;
  let reader: ReturnType<typeof captureOutcome> | undefined;
  let draining: Promise<void> | undefined;
  let callerDrained = false;
  mocks.read.mockImplementation(async () => {
    reading.resolve();
    await finishRead.promise;
    return { value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] } };
  });
  mocks.close.mockImplementation(async () => {
    closing.resolve();
    await finishClose.promise;
    mocks.events.push("close-settled");
  });
  const operation = captureOutcome(
    caller.track(() =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          observedSignal = getAsyncWorkSignal();
          observedSignal?.addEventListener(
            "abort",
            () => {
              abortListenerSignal = getAsyncWorkSignal();
            },
            { once: true },
          );
          descendant = trackAsyncWork(async () => {
            await finishDescendant.promise;
            mocks.events.push("descendant-settled");
          });
          reader = captureOutcome(
            executeExistingOpenClawStateRead({ path: mocks.source }, { type: "fleet.list" }),
          );
          entered.resolve();
          await finishCallback.promise;
        },
        { path: mocks.source },
      ),
    ),
  );
  try {
    expect(await Promise.race([entered.promise.then(() => "callback-entered"), operation])).toBe(
      "callback-entered",
    );
    expect(
      await Promise.race([reading.promise.then(() => "reader-entered"), reader ?? operation]),
    ).toBe("reader-entered");
    caller.beginClose(reason);
    draining = caller.drain().then(() => {
      callerDrained = true;
      mocks.events.push("caller-drained");
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(reason);
    expect(abortListenerSignal).toBe(observedSignal);
    finishCallback.resolve();
    finishRead.resolve();
    expect(
      await Promise.race([closing.promise.then(() => "transport-closing"), reader ?? operation]),
    ).toBe("transport-closing");
    expect(mocks.removed).toEqual([]);
    expect(caller.hasPendingWork).toBe(true);
    expect(callerDrained).toBe(false);
    finishClose.resolve();
    await reader;
    expect(mocks.removed).toEqual([]);
    expect(caller.hasPendingWork).toBe(true);
    expect(callerDrained).toBe(false);
  } finally {
    finishCallback.resolve();
    finishDescendant.resolve();
    finishRead.resolve();
    finishClose.resolve();
    await descendant;
    await reader;
    await operation;
    await (draining ?? caller.drain());
  }
  expect(mocks.events).toEqual(["close-settled", "descendant-settled", "remove", "caller-drained"]);
  expect(mocks.removed).toEqual([mocks.directory]);
});

it("preserves caller cancellation that precedes snapshot callback admission", async () => {
  const caller = new AsyncWorkScope();
  const reason = new Error("Controlled cancellation during preparation");
  const preparing = createDeferredCore();
  const entered = createDeferredCore();
  const finishPreparation = createDeferredCore<PreparedSqliteReadOnlyLocation>();
  const finishCallback = createDeferredCore();
  const prepared = adoptPreparedLocation(`${mocks.directory}/database.sqlite`, mocks.directory);
  let observed: { aborted: boolean | undefined; reason: unknown } | undefined;
  let draining: Promise<void> | undefined;
  mocks.prepare.mockImplementation(() => {
    preparing.resolve();
    return finishPreparation.promise;
  });
  const operation = captureOutcome(
    caller.track(() =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          const signal = getAsyncWorkSignal();
          observed = { aborted: signal?.aborted, reason: signal?.reason };
          entered.resolve();
          await finishCallback.promise;
        },
        { path: mocks.source },
      ),
    ),
  );
  try {
    expect(await Promise.race([preparing.promise.then(() => "preparing"), operation])).toBe(
      "preparing",
    );
    caller.beginClose(reason);
    draining = caller.drain();
    finishPreparation.resolve(prepared);
    const progress = await Promise.race([
      entered.promise.then(() => "callback-entered"),
      operation.then(() => "operation-settled"),
    ]);
    expect(progress).toBe("callback-entered");
    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBe(reason);
    expect(mocks.removed).toEqual([]);
    expect(caller.hasPendingWork).toBe(true);
  } finally {
    finishPreparation.resolve(prepared);
    finishCallback.resolve();
    await operation;
    await (draining ?? caller.drain());
  }
  expect(mocks.removed).toEqual([mocks.directory]);
});

it("retains tracked abort-listener cleanup when a snapshot callback completes normally", async () => {
  const listenerEntered = createDeferredCore();
  const finishTail = createDeferredCore();
  let callbackSignal: AbortSignal | undefined;
  let listenerSignal: AbortSignal | undefined;
  let tail: Promise<void> | undefined;
  let operationSettled = false;
  const operation = captureOutcome(
    withOpenClawStateDatabaseReadSnapshot(
      async () => {
        callbackSignal = getAsyncWorkSignal();
        callbackSignal?.addEventListener(
          "abort",
          () => {
            listenerSignal = getAsyncWorkSignal();
            tail = trackAsyncWork(async () => {
              await finishTail.promise;
              mocks.events.push("listener-tail-settled");
            });
            listenerEntered.resolve();
          },
          { once: true },
        );
        return "complete";
      },
      { path: mocks.source },
    ),
  ).then((outcome) => {
    operationSettled = true;
    mocks.events.push("operation-settled");
    return outcome;
  });
  try {
    expect(
      await Promise.race([listenerEntered.promise.then(() => "listener-entered"), operation]),
    ).toBe("listener-entered");
    // Let the fake close/removal promise chain settle while the listener tail stays held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.removed).toEqual([]);
    expect(operationSettled).toBe(false);
    expect(listenerSignal).toBe(callbackSignal);
  } finally {
    finishTail.resolve();
    await tail;
    await operation;
  }
  expect(await operation).toEqual({ value: "complete" });
  expect(mocks.events).toEqual(["listener-tail-settled", "remove", "operation-settled"]);
  expect(mocks.removed).toEqual([mocks.directory]);
});
