import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectCalls, makeReadSource, settle } from "./openclaw-state-db-fixtures.test-support.js";
import { createReadWorkerFixture } from "./openclaw-state-db-readonly.test-support.js";
import type { OpenClawStateReadOutcome } from "./openclaw-state-read.types.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  assertFresh: vi.fn<() => void>(),
  prepare: vi.fn(),
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
  getActiveOpenClawStateDatabaseReadSnapshot as activeSnapshot,
  withDisposableOpenClawStateReads,
  withExistingOpenClawStateDatabaseCurrentReadOnly as readCurrent,
  withExistingOpenClawStateDatabaseReadOnly as readOnly,
  withOpenClawStateDatabaseReadSnapshot as withSnapshot,
  withSynchronousArtifactPreservingStateSnapshot as withSyncSnapshot,
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
  mocks.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
  });
  mocks.assertFresh.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(true);
  mocks.capture.mockReset().mockImplementation((databasePath: string) => ({
    databasePath,
    identity: {},
    assertCurrent() {},
  }));
  mocks.prepare.mockReset().mockResolvedValue({
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
  });
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

it("retires snapshot admission even when discovery cleanup fails", async () => {
  mocks.cleanup.mockResolvedValueOnce(false);
  let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
  await expect(
    withSnapshot(async () => {
      escape = AsyncLocalStorage.snapshot();
      expect(activeSnapshot(options)).toBeDefined();
      return 1;
    }, options),
  ).rejects.toThrow("snapshot cleanup failed");
  await escape(expectRetiredAdmission);
  const other = { path: path.join(path.dirname(source), "other") };
  expect(escape(() => activeSnapshot(other))).toBeUndefined();
  expectCalls(0, mocks.forbiddenNative, mocks.read);
});

// Escaped continuations retain ALS, but admission ends before private bytes are removed.
async function expectRetiredAdmission() {
  const attempts = {
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

it.each(["snapshot", "disposable"] as const)(
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
      kind === "snapshot"
        ? withSnapshot(callback, options)
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
    expect(mocks.cleanup).toHaveBeenCalledTimes(kind === "snapshot" ? 1 : 0);
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
