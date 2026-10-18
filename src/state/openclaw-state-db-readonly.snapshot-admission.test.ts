import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import type {
  RetainedPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
} from "../infra/sqlite-readonly-location.types.js";
import * as snapshotWorker from "../infra/sqlite-readonly-worker.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectCalls, makeReadSource, settle } from "./openclaw-state-db-fixtures.test-support.js";
import {
  createReadWorkerFixture,
  observeAsyncFixture,
} from "./openclaw-state-db-readonly.test-support.js";
import type { OpenClawStateReadOutcome } from "./openclaw-state-read.types.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  assertFresh: vi.fn<() => void>(),
  prepare: vi.fn(),
  fork: vi.fn(),
  start: vi.fn<(...args: unknown[]) => RetainedSqliteSnapshotPreparation>(),
  closePreparation: vi.fn<() => Promise<void>>(),
  cleanup: vi.fn<() => Promise<boolean>>(),
  read: vi.fn<Parameters<typeof createReadWorkerFixture>[0]>(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Native reads must not be reached by rejected admission");
  }),
}));
vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-db-cache.js")>();
  return {
    ...actual,
    captureOpenClawStateDatabaseReadAdmission: mocks.capture,
    registerOpenClawStateDatabaseAsyncResource: () => () => {},
    borrowOpenClawStateDatabaseForAsyncRead: () => undefined,
    retainOpenClawStateDatabaseForIndependentRead: () => undefined,
    openClawStateDatabaseCache: {
      ...actual.openClawStateDatabaseCache,
      getCachedOpenClawStateDatabase: () => undefined,
      assertOpenClawStateDatabaseOpenAllowed() {},
      assertOpenClawStateDatabaseFreshOpenAllowedAtPath: mocks.assertFresh,
    },
  };
});
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>()),
  prepareSqliteReadOnlyLocation: mocks.prepare,
  prepareSqliteReadOnlyLocationSync: mocks.forbiddenNative,
  startSqliteReadOnlyLocationAsync: mocks.start,
  forkSqlitePrivateSnapshot: mocks.fork,
}));
vi.mock("../infra/sqlite-readonly-location-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-location-cleanup.js")>()),
  // Preparation is mocked; this fixture has no private directory to retain.
  retainSnapshotTempDirectory: () => () => {},
}));

vi.mock("./openclaw-state-db-read-connection.js", () => ({
  openOpenClawStateReadOnlyLocation: mocks.forbiddenNative,
  withOpenClawStateReadOnlyLocation: mocks.forbiddenNative,
}));

vi.mock("./openclaw-state-read-worker.js", () =>
  createReadWorkerFixture(mocks.read, async () => {}),
);

import { isStateDatabaseReadAdmissionInvalidatedError as isInvalidated } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead as readExisting,
  forkActiveOpenClawStateDatabaseReadSnapshot as forkSnapshot,
  getActiveOpenClawStateDatabaseReadSnapshot as activeSnapshot,
  withDisposableOpenClawStateReads,
  withExistingOpenClawStateDatabaseCurrentReadOnly as readCurrent,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync as readPreserving,
  withExistingOpenClawStateDatabaseReadOnly as readOnly,
  withOpenClawStateDatabaseReadSnapshot as withSnapshot,
  withSynchronousArtifactPreservingStateSnapshot as withSyncSnapshot,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import {
  getExistingOpenClawStateSchemaPath as existingSchemaPath,
  withExistingOpenClawStateSchema as withExistingSchema,
} from "./openclaw-state-db-schema-policy.js";
import { captureOpenClawStateWorkerContext as captureContext } from "./openclaw-state-worker-context.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
let source: string;
let options: { path: string };

beforeEach(() => {
  source = makeReadSource(directories, "state-snapshot-admission-").path;
  options = { path: source };
  mocks.forbiddenNative.mockClear();
  mocks.fork.mockReset();
  mocks.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
  });
  mocks.assertFresh.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(true);
  mocks.closePreparation.mockReset().mockResolvedValue();
  mocks.capture.mockReset().mockImplementation((databasePath: string) => ({
    databasePath,
    identity: {},
    assertCurrent() {},
  }));
  mocks.prepare.mockReset().mockResolvedValue({
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
  });
  mocks.start.mockReset().mockImplementation(() => {
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {
      retained.resolve(privateSource());
    });
    return {
      ...retained.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
});

function privateSource(): RetainedPreparedSqliteReadOnlyLocation {
  return {
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
    startCleanup: () => observeAsyncFixture(mocks.cleanup),
  };
}

it("closes an unused lazy scope without source admission, including escaped readers", async () => {
  let escaped!: ReturnType<typeof AsyncLocalStorage.snapshot>;
  await withSnapshot(
    async () => {
      escaped = AsyncLocalStorage.snapshot();
      expect(await forkSnapshot(options)).toBeUndefined();
    },
    { ...options, lazy: true },
  );
  await escaped(expectRetiredAdmission);
  expectCalls(0, mocks.capture, mocks.prepare, mocks.start, mocks.cleanup, mocks.forbiddenNative);
});

it("lets a sync reader join the same lazy preparation started by an async reader", async () => {
  let ready = false;
  let delivered = false;
  mocks.start.mockImplementation(() => {
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {
      if (ready) {
        retained.resolve(privateSource());
      }
    });
    return {
      ...retained.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
  await withSnapshot(
    async () => {
      const reading = readExisting(options, { type: "backup.runs" }).then((result) => {
        delivered = true;
        return result;
      });
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.read).not.toHaveBeenCalled();
      ready = true;
      const snapshot = activeSnapshot(options);
      expect(snapshot?.location).toBe("/fixture/private.sqlite");
      expect(delivered).toBe(false);
      await expect(reading).resolves.toMatchObject({ runs: [] });
      await readExisting(options, { type: "backup.runs" });
      expect(activeSnapshot(options)).toBe(snapshot);
      expect(mocks.read.mock.calls.map(([location]) => location.location)).toEqual([
        "/fixture/private.sqlite",
        "/fixture/private.sqlite",
      ]);
      expect(mocks.cleanup).not.toHaveBeenCalled();
    },
    { ...options, lazy: true },
  );
  expectCalls(1, mocks.start, mocks.cleanup, mocks.closePreparation);
  expectCalls(0, mocks.prepare, mocks.forbiddenNative);
});

it("honors preservation entered after a lazy report was created", async () => {
  const identity = { key: "file:7:9" };
  const refusal = new Error("stop after observing nested preservation admission");
  mocks.capture.mockReturnValue({ identity, assertCurrent() {} });
  mocks.start.mockImplementation(() => {
    const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
    preparation.reject(refusal);
    return {
      ...preparation.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
  await expect(
    withSnapshot(
      async () => {
        expect(mocks.start).not.toHaveBeenCalled();
        await readPreserving(() => "unreachable", options);
      },
      { ...options, lazy: true },
    ),
  ).rejects.toBe(refusal);
  expect(mocks.start).toHaveBeenCalledWith(
    source,
    expect.objectContaining({
      preserveSourceArtifacts: true,
      expectedSourceIdentity: identity,
    }),
  );
  expectCalls(1, mocks.start, mocks.closePreparation);
  expectCalls(0, mocks.prepare, mocks.forbiddenNative);
});

it("joins in-flight materialization before lending a private fork", async () => {
  const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
  mocks.start.mockReturnValue({
    ...preparation.operation,
    startClose: () => observeAsyncFixture(mocks.closePreparation),
  });
  const family = { root: "/fixture", main: "1:2:3:4:5:6", wal: "1:7:8:9:10:11" };
  const fork = { location: "/fixture/fork.sqlite" };
  mocks.fork.mockResolvedValue(fork);
  await withSnapshot(
    async () => {
      const reading = readExisting(options, { type: "backup.runs" });
      const forking = forkSnapshot(options);
      expect(mocks.fork).not.toHaveBeenCalled();
      preparation.resolve({ ...privateSource(), privateFamily: family });
      expect(await forking).toBe(fork);
      await reading;
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.fork.mock.calls[0]?.slice(0, 2)).toEqual(["/fixture/private.sqlite", family]);
    },
    { ...options, lazy: true },
  );
});

it("drains a cancelled fork before releasing the report source", async () => {
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const caller = new AsyncWorkScope();
  const cancelled = new Error("caller cancelled private fork");
  mocks.prepare.mockResolvedValue({
    ...privateSource(),
    privateFamily: { root: "/fixture", main: "1:2:3:4:5:6", wal: null },
  });
  mocks.fork.mockImplementation(async (_path, _family, signal: AbortSignal) => {
    entered.resolve();
    await finish.promise;
    signal.throwIfAborted();
  });
  const operation = settle(
    caller.track(() =>
      withSnapshot(async () => {
        await forkSnapshot(options);
      }, options),
    ),
  );
  await entered.promise;
  caller.beginClose(cancelled);
  expect(mocks.cleanup).not.toHaveBeenCalled();
  finish.resolve();
  expect(await operation).toEqual({ error: cancelled });
  await caller.drain();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});

it("joins failed eager retained production and preserves its cleanup failure", async () => {
  const failure = new Error("retained producer failed");
  const cleanupFailure = new Error("retained producer cleanup failed");
  const closing = createDeferredCore();
  const finishClose = createDeferredCore();
  mocks.start.mockImplementation(() => {
    const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
    preparation.reject(failure);
    return {
      ...preparation.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
  mocks.closePreparation.mockImplementation(async () => {
    closing.resolve();
    await finishClose.promise;
    throw cleanupFailure;
  });
  let settled = false;
  const operation = settle(
    withArtifactPreservingStateReads(() => withSnapshot(async () => "unreachable", options)),
  ).then((result) => {
    settled = true;
    return result;
  });
  await closing.promise;
  expect(settled).toBe(false);
  finishClose.resolve();
  expect(await operation).toMatchObject({
    error: { cause: failure, errors: [failure, cleanupFailure] },
  });
  expectCalls(1, mocks.start, mocks.closePreparation);
  expectCalls(0, mocks.prepare, mocks.cleanup);
});

it("keeps current and live reads outside the lazy report source", async () => {
  await withSnapshot(
    async () => {
      await readExisting(options, { type: "backup.runs" }, { current: true });
      await readExisting(options, { type: "backup.runs" }, { live: true });
      expect(mocks.start).not.toHaveBeenCalled();
      await readExisting(options, { type: "backup.runs" });
      await readExisting(options, { type: "backup.runs" }, { current: true });
      expect(mocks.read.mock.calls.map(([location]) => location.location)).toEqual([
        source,
        source,
        "/fixture/private.sqlite",
        source,
      ]);
    },
    { ...options, lazy: true },
  );
  expectCalls(1, mocks.start, mocks.cleanup);
});

it("rechecks source admission after lazy materialization and cleans rejected bytes", async () => {
  const failure = new Error("source admission changed during preparation");
  mocks.capture.mockImplementation((databasePath: string) => ({
    databasePath,
    identity: {},
    assertCurrent() {
      throw failure;
    },
  }));
  await expect(
    withSnapshot(async () => activeSnapshot(options), { ...options, lazy: true }),
  ).rejects.toBe(failure);
  expectCalls(1, mocks.start, mocks.cleanup, mocks.closePreparation);
  expectCalls(0, mocks.read, mocks.forbiddenNative);
});

it("joins lazy preparation close after caller cancellation", async () => {
  const caller = new AsyncWorkScope();
  const started = createDeferredCore();
  const closing = createDeferredCore();
  const finishClose = createDeferredCore();
  const cancelled = new Error("caller cancelled lazy preparation");
  mocks.closePreparation.mockImplementation(async () => {
    closing.resolve();
    await finishClose.promise;
  });
  mocks.start.mockImplementation((_pathname, value) => {
    const { signal } = value as { signal: AbortSignal };
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {
      started.resolve();
      if (signal.aborted) {
        retained.reject(signal.reason);
      }
    });
    signal.addEventListener("abort", () => retained.operation.service(), { once: true });
    return {
      ...retained.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
  let settled = false;
  const result = settle(
    caller.track(() =>
      withSnapshot(
        async () => {
          await readExisting(options, { type: "backup.runs" });
        },
        { ...options, lazy: true },
      ),
    ),
  ).then((value) => {
    settled = true;
    return value;
  });
  await started.promise;
  caller.beginClose(cancelled);
  try {
    await closing.promise;
    expect(settled).toBe(false);
  } finally {
    finishClose.resolve();
  }
  expect(await result).toEqual({ error: cancelled });
  await caller.drain();
  expectCalls(1, mocks.start, mocks.closePreparation);
  expectCalls(0, mocks.read, mocks.cleanup, mocks.forbiddenNative);
});

it("does not query a canceled read after the shared preparation completes", async () => {
  const caller = new AbortController();
  const cancelled = new Error("only this read was cancelled");
  const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
  mocks.start.mockReturnValue({
    ...preparation.operation,
    startClose: () => observeAsyncFixture(mocks.closePreparation),
  });
  await withSnapshot(
    async () => {
      const reading = settle(
        readExisting(options, { type: "backup.runs" }, { signal: caller.signal }),
      );
      caller.abort(cancelled);
      preparation.resolve(privateSource());
      expect(await reading).toEqual({ error: cancelled });
      expect(mocks.read).not.toHaveBeenCalled();
      await expect(readExisting(options, { type: "backup.runs" })).resolves.toMatchObject({
        runs: [],
      });
    },
    { ...options, lazy: true },
  );
  expectCalls(1, mocks.start, mocks.read, mocks.cleanup, mocks.closePreparation);
});

it("bounds sync joining even when the async caller owns the deadline", async () => {
  const budget = vi.spyOn(snapshotWorker, "readSqliteInspectionBudget").mockReturnValue({
    timeoutMs: 0,
    size: "controlled fixture",
  });
  mocks.start.mockImplementation((_pathname, value) => {
    const { signal } = value as { signal: AbortSignal };
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {
      if (signal.aborted) {
        retained.reject(signal.reason);
      }
    });
    signal.addEventListener("abort", () => retained.operation.service(), { once: true });
    return {
      ...retained.operation,
      startClose: () => observeAsyncFixture(mocks.closePreparation),
    };
  });
  try {
    await expect(
      snapshotWorker.withSqliteReadOnlyWorkerScope(
        () => withSnapshot(async () => activeSnapshot(options), { ...options, lazy: true }),
        { signal: new AbortController().signal, deadlineOwnedByCaller: true },
      ),
    ).rejects.toThrow("SQLite read-only snapshot timed out");
    expectCalls(1, mocks.start, mocks.closePreparation);
    expectCalls(0, mocks.read, mocks.cleanup, mocks.forbiddenNative);
  } finally {
    budget.mockRestore();
  }
});

it("waits for temporary schema custody before admitting one discovery snapshot", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    mocks.assertFresh.mockImplementation(() => {
      if (performance.now() < 9_000) {
        throw new StateDatabaseAdmissionPendingError(source, "temporary schema custody");
      }
    });
    const operation = vi.fn(async () => "admitted");
    const read = withSnapshot(operation, {
      path: source,
      admissionTimeoutMs: 300_000,
    });
    const outcome = settle(read);
    expectCalls(0, mocks.capture, mocks.prepare, operation);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await outcome).toEqual({ value: "admitted" });
    expectCalls(1, operation, mocks.cleanup);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  "maintenance",
  "other database",
  "default",
  "exhausted",
  "cancelled",
  "shutdown",
] as const)("refuses %s before preparing discovery bytes", async (kind) => {
  const refusal =
    kind === "maintenance"
      ? new Error("genuine offline maintenance")
      : new StateDatabaseAdmissionPendingError(
          kind === "other database" ? path.join(path.dirname(source), "other") : source,
          "temporary schema custody",
        );
  const caller = new AsyncWorkScope();
  const cancelled = new Error("caller closed while waiting for schema custody");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    mocks.assertFresh.mockImplementation(() => {
      throw refusal;
    });
    const operation = vi.fn(async () => "must not enter");
    const read = caller.track(() =>
      withSnapshot(operation, {
        path: source,
        admissionTimeoutMs: kind === "default" ? undefined : 300_000,
      }),
    );
    let settled = false;
    const outcome = settle(read).then((result) => {
      settled = true;
      return result;
    });
    if (kind === "exhausted") {
      await vi.advanceTimersByTimeAsync(299_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    } else if (kind === "cancelled") {
      caller.beginClose(cancelled);
    } else if (kind === "shutdown") {
      await cleanupSnapshotOperations();
    }
    const cause =
      kind === "cancelled"
        ? { name: "AbortError", cause: cancelled }
        : kind === "shutdown"
          ? { name: "AbortError" }
          : refusal;
    expect(await outcome).toMatchObject({ error: { cause } });
    expectCalls(0, mocks.capture, mocks.prepare, operation, mocks.cleanup);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    caller.beginClose(cancelled);
    await caller.drain();
    vi.useRealTimers();
  }
});

it("preserves discovery capture failure without preparing bytes", async () => {
  const failure = new Error("synthetic admission refusal");
  mocks.capture.mockImplementation(() => {
    throw failure;
  });
  const operation = vi.fn(async () => 1);
  await expect(withSnapshot(operation, options)).rejects.toMatchObject({
    message: expect.stringContaining("Cannot read shared state for discovery: " + source),
    cause: failure,
  });
  expectCalls(0, mocks.prepare, operation);
});

it.each([false, true])(
  "retires snapshot admission even when discovery cleanup fails (lazy=%s)",
  async (lazy) => {
    mocks.cleanup.mockResolvedValueOnce(false);
    let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
    await expect(
      withSnapshot(
        async () => {
          escape = AsyncLocalStorage.snapshot();
          expect(activeSnapshot(options)).toBeDefined();
          return 1;
        },
        { ...options, lazy },
      ),
    ).rejects.toThrow("snapshot cleanup failed");
    await escape(expectRetiredAdmission);
    const other = { path: path.join(path.dirname(source), "other") };
    expect(escape(() => activeSnapshot(other))).toBeUndefined();
    expectCalls(0, mocks.forbiddenNative, mocks.read);
  },
);

// Escaped continuations retain ALS, but admission ends before private bytes are removed.
async function expectRetiredAdmission() {
  const attempts = {
    fork: () => forkSnapshot(options),
    getter: () => activeSnapshot(options),
    native: () => readOnly(() => "read", options),
    currentRows: () => readCurrent(() => "read", options),
    currentSnapshot: () => withSyncSnapshot(() => "read", { current: options }),
    nestedSnapshot: () => withSnapshot(async () => "nested", options),
    nestedDisposable: () => withDisposableOpenClawStateReads(source, async () => "nested"),
    worker: () => readExisting(options, { type: "backup.runs" }),
  };
  await Promise.all(
    Object.entries(attempts).map(async ([name, run]) => {
      const result = await settle(Promise.resolve().then<unknown>(() => run()));
      expect("error" in result && isInvalidated(result.error), name).toBe(true);
    }),
  );
}

it.each(["snapshot", "lazy", "disposable"] as const)(
  "drains an admitted %s reader while rejecting escaped new reads, then rejects the closed scope",
  async (kind) => {
    const started = createDeferredCore();
    const finishRead = createDeferredCore();
    const startedClosing = createDeferredCore();
    const expected: OpenClawStateReadOutcome = {
      value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
    };
    mocks.read.mockImplementation(async (_source, authority) => {
      const scopeSignal = getAsyncWorkSignal();
      if (!scopeSignal) {
        throw new Error("Read must be owned by its retained scope");
      }
      scopeSignal.addEventListener("abort", () => startedClosing.resolve(), { once: true });
      started.resolve();
      await finishRead.promise;
      authority.assertCurrent();
      return expected;
    });
    let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
    let read!: ReturnType<typeof readExisting>;
    const callback = async () => {
      escape = AsyncLocalStorage.snapshot();
      read = readExisting(options, { type: "backup.runs" });
      await started.promise;
    };
    const closing =
      kind !== "disposable"
        ? withSnapshot(callback, { ...options, lazy: kind === "lazy" })
        : withDisposableOpenClawStateReads(source, callback);
    await startedClosing.promise;
    try {
      expect(mocks.cleanup).not.toHaveBeenCalled();
      await escape(expectRetiredAdmission);
      expect(mocks.read).toHaveBeenCalledOnce();
    } finally {
      finishRead.resolve();
      await read;
      await closing;
    }
    expect(await read).toEqual(expected.value);
    await escape(expectRetiredAdmission);
    expect(mocks.forbiddenNative).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledTimes(kind !== "disposable" ? 1 : 0);
  },
);

it("keeps captured schema authority while selecting current rows", async () => {
  await withExistingSchema(options, () =>
    withSnapshot(async () => {
      const context = captureContext(options);
      mocks.read.mockImplementation(async (location) => {
        expect(location.context).toBe(context);
        expect([existingSchemaPath(), location.location]).toEqual([source, source]);
        return { value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] } };
      });
      await expect(
        readExisting(options, { type: "backup.runs" }, { current: true, context }),
      ).resolves.toMatchObject({ ok: true, runs: [] });
      expect(mocks.read).toHaveBeenCalledOnce();
    }, options),
  );
  expect(mocks.forbiddenNative).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
