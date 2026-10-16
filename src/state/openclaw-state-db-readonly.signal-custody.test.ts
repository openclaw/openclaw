import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import {
  adoptPreparedLocation,
  cleanupSnapshotOperations,
} from "../infra/sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  observeAsyncFixture,
  retainFixturePreparation,
} from "./openclaw-state-db-readonly.test-support.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readResult: OpenClawStateReadOutcome = {
  value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
};

const mocks = vi.hoisted(() => ({
  cleanupKey: Symbol("signal-custody snapshot cleanup"),
  source: "",
  sourceIdentity: { key: "", canonicalPath: "" },
  directory: "/synthetic/state/snapshot",
  resources: new Set<OpenClawStateDatabaseAsyncResource>(),
  removed: [] as string[],
  events: [] as string[],
  prepare: vi.fn<Prepare>(),
  removeAsync: vi.fn<(file: string) => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  read: vi.fn<Read>(),
  admission: (databasePath: string): OpenClawStateWorkerContext["admission"] => ({
    coordinationKey: databasePath,
    databasePath,
    identity: mocks.sourceIdentity,
    assertCurrent() {},
  }),
  forbidden: vi.fn(() => {
    throw new Error("This controlled custody test must not open SQLite or start a worker");
  }),
}));
type Prepare = (
  path: string,
  options?: {
    signal?: AbortSignal;
    preserveSourceArtifacts?: boolean;
  },
) => Promise<PreparedSqliteReadOnlyLocation>;
type Read = (
  source: OpenClawStateReadLocation,
  authority: OpenClawStateReadAuthority,
) => Promise<OpenClawStateReadOutcome>;

// Synthetic files and captured exit callbacks must not reuse another file's native cleanup owner.
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      const [key, ...rest] = args;
      return actual.resolveGlobalSingleton(
        key === Symbol.for("openclaw.sqliteSnapshotCleanup") ? mocks.cleanupKey : key,
        ...rest,
      );
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const remove = (
    file: Parameters<typeof actual.rmSync>[0],
    options?: Parameters<typeof actual.rmSync>[1],
  ) => {
    if (file !== mocks.directory && file !== "/synthetic/state/initial-snapshot") {
      return actual.rmSync(file, options);
    }
    mocks.removed.push(file);
    mocks.events.push("remove");
  };
  return {
    ...actual,
    default: {
      ...actual,
      rmSync: remove,
      promises: { ...actual.promises, rm: mocks.removeAsync },
    },
  };
});
vi.mock("../cli/signal-exit-barrier.js", () => ({ registerSignalExitFinalizer: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ getChildLogger: () => ({ warn: vi.fn() }) }));
vi.mock("./openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: mocks.admission,
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
    admission: mocks.admission(path),
    environment: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  }),
}));

vi.mock("../infra/sqlite-snapshot-source.js", () => ({
  prepareSqliteReadOnlyLocation: mocks.prepare,
  startSqliteReadOnlyLocationAsync: (...args: Parameters<typeof mocks.prepare>) =>
    retainFixturePreparation(
      observeAsyncFixture(async () => {
        const prepared = await mocks.prepare(...args);
        return {
          ...prepared,
          startCleanup: () => observeAsyncFixture(() => prepared.cleanupAsync()),
        };
      }),
    ),
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
// mock-isolation: Synchronous schema admission or reads must fail in async signal-custody tests.
vi.mock("./openclaw-state-db-schema-version.js", () => ({
  admitStateSchemaFacts: mocks.forbidden,
  assertSupportedStateSchemaVersion: mocks.forbidden,
}));
vi.mock("./openclaw-state-read-worker.js", async () => {
  const { createReadWorkerFixture } = await import("./openclaw-state-db-readonly.test-support.js");
  return createReadWorkerFixture(mocks.read, mocks.close);
});

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
afterAll(async () => {
  try {
    await cleanupSnapshotOperations();
    expect(mocks.resources.size).toBe(0);
    Reflect.deleteProperty(globalThis, mocks.cleanupKey);
  } finally {
    restoreExitSpy();
  }
});

beforeEach(() => {
  mocks.source = join(tempDirs.make("openclaw-signal-custody-source-"), "source.sqlite");
  fs.writeFileSync(mocks.source, "Controlled source identity; this fixture never opens SQLite.");
  mocks.sourceIdentity = readDatabasePathIdentitySync(mocks.source);
  mocks.removed.length = 0;
  mocks.events.length = 0;
  mocks.forbidden.mockClear();
  mocks.removeAsync.mockReset().mockImplementation(async (file) => {
    mocks.removed.push(file);
    mocks.events.push("remove");
  });
  mocks.prepare.mockReset().mockImplementation(async () => location());
  mocks.close.mockReset().mockResolvedValue();
  mocks.read.mockReset().mockResolvedValue(readResult);
});

afterEach(async () => {
  mocks.close.mockResolvedValue();
  await closeResources();
  await cleanupSnapshotOperations();
  expect(mocks.resources.size).toBe(0);
  expect(mocks.forbidden).not.toHaveBeenCalled();
});

function runDirectRead() {
  return withArtifactPreservingStateReads(read);
}

const read = () =>
  executeExistingOpenClawStateRead({ path: mocks.source }, { type: "backup.runs" });
const snapshot = <T>(callback: () => Promise<T>) =>
  withOpenClawStateDatabaseReadSnapshot(callback, { path: mocks.source });
const location = (deferCleanup = false) =>
  adoptPreparedLocation(`${mocks.directory}/database.sqlite`, mocks.directory, deferCleanup);

function hold<TArgs extends unknown[], TResult>(
  mock: Mock<(...args: TArgs) => Promise<TResult>>,
  result: TResult,
  event?: string,
) {
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  mock.mockImplementation(async () => {
    entered.resolve();
    await finish.promise;
    if (event) {
      mocks.events.push(event);
    }
    return result;
  });
  return { entered: entered.promise, release: finish.resolve };
}

async function closeResources() {
  for (const resource of mocks.resources) {
    await resource.close();
  }
}

async function expectEntered(entered: Promise<unknown>, operation: Promise<unknown>) {
  expect(await Promise.race([entered.then(() => "entered"), operation])).toBe("entered");
}

function expectCallerPending(caller: AsyncWorkScope, drained = false) {
  expect({ removed: mocks.removed, pending: caller.hasPendingWork, drained }).toEqual({
    removed: [],
    pending: true,
    drained: false,
  });
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

it.each([
  { capable: false, failure: "busy", succeeds: true },
  { capable: true, failure: "busy", succeeds: false },
  { capable: false, failure: "permission", succeeds: false },
  { capable: false, failure: "read", succeeds: false },
  { capable: false, failure: "native close", succeeds: false },
] as const)(
  "settles discovery with $failure cleanup (native close capable: $capable)",
  async ({ capable, failure, succeeds }) => {
    const runtime = vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
      ...sqliteRuntime.getSqliteRuntimeCapabilities(),
      explicitSqliteCloseReleasesNativeResources: capable,
    });
    const busy = Object.assign(new Error("private SQLite file is still open"), {
      code: failure === "permission" ? "EACCES" : "EBUSY",
    });
    mocks.prepare.mockImplementation(async () => location(true));
    mocks.removeAsync.mockRejectedValue(busy);
    if (failure === "native close") {
      mocks.close.mockRejectedValue(new Error("native close failed"));
    }
    try {
      const result = await captureOutcome(
        snapshot(async () => {
          await read();
          if (failure === "read") {
            throw new Error("discovery read failed");
          }
          return "discovered";
        }),
      );
      expect(mocks.removed).toEqual([]);
      mocks.close.mockResolvedValue();
      mocks.removeAsync.mockImplementation(async (file) => {
        mocks.removed.push(file);
      });
      await closeResources();
      await cleanupSnapshotOperations();
      expect(mocks.removed).toEqual([mocks.directory]);
      expect(mocks.read).toHaveBeenCalledOnce();
      if (succeeds) {
        expect(result).toEqual({ value: "discovered" });
      } else {
        expect(result).toHaveProperty("error");
      }
    } finally {
      runtime.mockRestore();
    }
  },
);

it.each(["direct", "snapshot"] as const)(
  "joins a pending %s preparation handoff before removing its directory",
  async (kind) => {
    const prepared = location();
    const preparation = hold(mocks.prepare, prepared);
    const operation = captureOutcome(
      kind === "direct" ? runDirectRead() : snapshot(async () => "complete"),
    );
    await expectEntered(preparation.entered, operation);
    const cleanup = cleanupSnapshotOperations();
    try {
      assertFilesRetained();
    } finally {
      preparation.release();
      await operation;
      await cleanup;
    }
    expect(mocks.removed).toEqual([mocks.directory]);
    expect(mocks.read).not.toHaveBeenCalled();
  },
);

it("joins the direct reader and its transport close before deleting prepared bytes", async () => {
  const reading = hold(mocks.read, readResult, "read-settled");
  const closing = hold(mocks.close, undefined, "close-settled");
  const operation = captureOutcome(runDirectRead());
  await reading.entered;
  const cleanup = cleanupSnapshotOperations();
  try {
    assertFilesRetained();
    reading.release();
    await closing.entered;
    assertFilesRetained();
  } finally {
    reading.release();
    closing.release();
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
    snapshot(async () => {
      escaped = AsyncLocalStorage.snapshot();
      entered.resolve();
      await finishCallback.promise;
      mocks.events.push("callback-settled");
    }),
  );
  await entered.promise;
  const cleanup = cleanupSnapshotOperations();
  try {
    assertFilesRetained();
    const rejected = await escaped(() => captureOutcome(Promise.resolve().then(read)));
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
    const prepareLocation = () => (prepared ??= location());
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
  const reading = hold(mocks.read, readResult);
  const closing = hold(mocks.close, undefined, "close-settled");
  const finishCallback = createDeferredCore();
  const finishDescendant = createDeferredCore();
  let observedSignal: AbortSignal | undefined;
  let abortListenerSignal: AbortSignal | undefined;
  let descendant: Promise<void> | undefined;
  let reader: ReturnType<typeof captureOutcome> | undefined;
  let draining: Promise<void> | undefined;
  let callerDrained = false;
  const operation = captureOutcome(
    caller.track(() =>
      snapshot(async () => {
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
        reader = captureOutcome(read());
        entered.resolve();
        await finishCallback.promise;
      }),
    ),
  );
  try {
    await expectEntered(entered.promise, operation);
    await expectEntered(reading.entered, reader ?? operation);
    caller.beginClose(reason);
    draining = caller.drain().then(() => {
      callerDrained = true;
      mocks.events.push("caller-drained");
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(reason);
    expect(abortListenerSignal).toBe(observedSignal);
    finishCallback.resolve();
    reading.release();
    await expectEntered(closing.entered, reader ?? operation);
    expectCallerPending(caller, callerDrained);
    closing.release();
    expect(await reader).toEqual({ error: reason });
    expectCallerPending(caller, callerDrained);
  } finally {
    finishCallback.resolve();
    finishDescendant.resolve();
    reading.release();
    closing.release();
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
  const entered = createDeferredCore();
  const finishCallback = createDeferredCore();
  const prepared = location();
  let observed: { aborted: boolean | undefined; reason: unknown } | undefined;
  let draining: Promise<void> | undefined;
  const preparation = hold(mocks.prepare, prepared);
  const operation = captureOutcome(
    caller.track(() =>
      snapshot(async () => {
        const signal = getAsyncWorkSignal();
        observed = { aborted: signal?.aborted, reason: signal?.reason };
        entered.resolve();
        await finishCallback.promise;
      }),
    ),
  );
  try {
    await expectEntered(preparation.entered, operation);
    caller.beginClose(reason);
    draining = caller.drain();
    preparation.release();
    const progress = await Promise.race([
      entered.promise.then(() => "callback-entered"),
      operation.then(() => "operation-settled"),
    ]);
    expect(progress).toBe("callback-entered");
    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toBe(reason);
    expectCallerPending(caller);
  } finally {
    preparation.release();
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
    snapshot(async () => {
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
    }),
  ).then((outcome) => {
    operationSettled = true;
    mocks.events.push("operation-settled");
    return outcome;
  });
  try {
    await expectEntered(listenerEntered.promise, operation);
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
