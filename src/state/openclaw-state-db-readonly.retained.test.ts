import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { createOwnedWorkerTaskPoolMock } from "../infra/worker-task-pool.mock.test-support.js";
import type { RetainedWorkerTask, WorkerTaskInput } from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

vi.hoisted(() => vi.resetModules());
const mock = vi.hoisted(() => ({
  pool: vi.fn(),
  borrow: vi.fn(),
  prepareNative: vi.fn(),
  prepareFresh: vi.fn(),
  prepareInherited: vi.fn(),
}));
vi.mock("../infra/worker-task-pool.js", async (original) => ({
  ...(await original<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: mock.pool,
}));
vi.mock("./openclaw-state-db-cache.js", async (original) => ({
  ...(await original<typeof import("./openclaw-state-db-cache.js")>()),
  borrowOpenClawStateDatabaseForAsyncRead: mock.borrow,
}));
vi.mock("../infra/sqlite-readonly-location.js", async (original) => ({
  ...(await original<typeof import("../infra/sqlite-readonly-location.js")>()),
  prepareSqliteReadOnlyLocationFromOwnedDatabase: mock.prepareNative,
}));
vi.mock("../infra/sqlite-snapshot-source.js", async (original) => ({
  ...(await original<typeof import("../infra/sqlite-snapshot-source.js")>()),
  startSqliteReadOnlyLocationAsync: mock.prepareFresh,
  prepareSqliteReadOnlyLocation: mock.prepareInherited,
}));

import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import * as readWorker from "./openclaw-state-read-worker.js";

const owner = new AsyncLocalStorage<string>();
const events: string[] = [];
let ready = false;
let occupied = 0;
let submitted = createDeferredCore();
const tasks: Array<RetainedWorkerTask<OpenClawStateReadReply>> = [];
const releaseFixtures: Array<() => void> = [];
const reply: OpenClawStateReadReply = {
  ok: true,
  type: "fleet.list",
  sourceAdmitted: true,
  cells: [],
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    ready = true;
    for (const release of releaseFixtures.splice(0)) {
      release();
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

beforeEach(() => {
  ready = false;
  occupied = 0;
  tasks.length = 0;
  events.length = 0;
  submitted = createDeferredCore();
  mock.borrow.mockReset();
  mock.prepareNative.mockReset();
  mock.prepareFresh.mockReset();
  mock.prepareInherited.mockReset();
  mock.pool.mockReset().mockImplementation(() =>
    createOwnedWorkerTaskPoolMock<OpenClawStateReadRequest, OpenClawStateReadReply>({
      startTask(input: WorkerTaskInput<OpenClawStateReadRequest>) {
        const name = owner.getStore();
        const inContext = AsyncLocalStorage.snapshot();
        let admitted = false;
        let released = false;
        let taskReply: OpenClawStateReadReply = reply;
        const completion = createRetainedOperation<OpenClawStateReadReply>(() => {
          if (completion.operation.read().status !== "pending") {
            return;
          }
          if (!admitted && occupied < 2) {
            const request = typeof input === "function" ? input() : input;
            if (request instanceof Promise) {
              throw new Error("This worker fixture requires synchronous admission");
            }
            expect(owner.getStore()).toBe(name);
            taskReply = request.command.type === "admit" ? { ok: true, type: "admit" } : reply;
            occupied++;
            admitted = true;
            events.push(`admit ${name}`);
          }
          if (admitted && ready) {
            completion.resolve(taskReply);
          }
        });
        const cleanup = createRetainedOperation<void>(() => {
          completion.operation.service();
          if (completion.operation.read().status === "pending") {
            return;
          }
          if (!released) {
            released = true;
            occupied--;
            expect(owner.getStore()).toBe(name);
            events.push(`release ${name}`);
          }
          cleanup.resolve(undefined);
        });
        const task = { ...completion.operation, release: () => cleanup.operation };
        tasks.push(task);
        releaseFixtures.push(() =>
          inContext(() => {
            task.service();
            task.release().service();
          }),
        );
        submitted.resolve();
        return task;
      },
    }),
  );
});

function source() {
  const root = tempDirs.make("openclaw-retained-read-");
  const pathname = path.join(root, "source.sqlite");
  fs.writeFileSync(pathname, "synthetic worker source");
  return { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
}

function observeReaders() {
  const captureSource = readWorker.captureOpenClawStateReadSource;
  const readers: Array<{
    name: string | undefined;
    source: ReturnType<typeof captureSource>;
    released: ReturnType<typeof vi.fn>;
  }> = [];
  vi.spyOn(readWorker, "captureOpenClawStateReadSource").mockImplementation(() => {
    const capturedSource = captureSource();
    const name = owner.getStore();
    const released = vi.fn();
    readers.push({ name, source: capturedSource, released });
    return {
      ...capturedSource,
      own(service, close) {
        const unregister = capturedSource.own(service, close);
        return () => {
          expect(owner.getStore()).toBe(name);
          unregister();
          released();
        };
      },
    };
  });
  return (name?: string) => {
    const reader = readers.find((entry) => entry.name === name);
    if (!reader) {
      throw new Error(`Read source was not captured for ${name ?? "the caller"}`);
    }
    return reader;
  };
}

it("services two ordinary readers through release before admitting a queued reader", async () => {
  const observed = observeReaders();
  const options = source();
  const first = owner.run("first", () =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  );
  const second = owner.run("second", () =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  );
  const follower = owner.run("follower", () =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  );
  expect(events).toEqual(["admit first", "admit second"]);
  ready = true;
  let microtaskRan = false;
  queueMicrotask(() => {
    microtaskRan = true;
  });
  // The real captured source advances all owners, including the earlier reads' release tails.
  owner.run("unrelated caller", () => observed("follower").source.service());
  expect(microtaskRan).toBe(false);
  for (const name of ["first", "second", "follower"]) {
    expect(observed(name).released).toHaveBeenCalledOnce();
  }
  expect(events).toEqual([
    "admit first",
    "admit second",
    "release first",
    "release second",
    "admit follower",
    "release follower",
  ]);
  expect(occupied).toBe(0);
  await expect(Promise.all([first, second, follower])).resolves.toEqual([reply, reply, reply]);
});

it("keeps native backup asynchronous while a later source services its query release", async () => {
  const observed = observeReaders();
  const options = source();
  const backup = createDeferredCore<{ location: string; cleanupAsync(): Promise<boolean> }>();
  const nativeCleanup = createDeferredCore<boolean>();
  const release = vi.fn();
  const observe = vi.fn();
  mock.borrow.mockReturnValueOnce({ database: { db: {} }, assertCurrent() {}, observe, release });
  mock.prepareNative.mockReturnValueOnce(backup.promise);
  releaseFixtures.push(() => {
    backup.resolve({ location: options.path, cleanupAsync: () => nativeCleanup.promise });
    nativeCleanup.resolve(true);
  });
  const first = owner.run("native", () =>
    withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
    ),
  );
  observed("native").source.service();
  expect(mock.prepareNative).toHaveBeenCalledOnce();
  expect(mock.prepareFresh).not.toHaveBeenCalled();
  expect(tasks).toHaveLength(0);
  expect(observed("native").released).not.toHaveBeenCalled();
  const cleanupAsync = vi.fn(() => nativeCleanup.promise);
  backup.resolve({ location: options.path, cleanupAsync });
  await submitted.promise;
  const second = owner.run("second", () =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  );
  const follower = owner.run("follower", () =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  );
  ready = true;
  let microtaskRan = false;
  queueMicrotask(() => {
    microtaskRan = true;
  });
  observed("follower").source.service();
  expect(microtaskRan).toBe(false);
  expect(observed("follower").released).toHaveBeenCalledOnce();
  expect(observed("second").released).toHaveBeenCalledOnce();
  expect(observed("native").released).not.toHaveBeenCalled();
  expect(events).toEqual([
    "admit native",
    "admit second",
    "release native",
    "release second",
    "admit follower",
    "release follower",
  ]);
  expect(observe).toHaveBeenCalledOnce();
  expect(cleanupAsync).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  nativeCleanup.resolve(true);
  await expect(Promise.all([first, second, follower])).resolves.toEqual([reply, reply, reply]);
  expect(release).toHaveBeenCalledOnce();
  expect(observed("native").released).toHaveBeenCalledOnce();
  expect(mock.prepareFresh).not.toHaveBeenCalled();
});

it("finishes fresh snapshot preparation, query, and snapshot cleanup without Promise callbacks", async () => {
  const observed = observeReaders();
  const options = source();
  const snapshotCleanup = createRetainedOperation<boolean>(() => {
    expect(events.at(-1)).toBe("release fresh");
    events.push("snapshot cleaned");
    snapshotCleanup.resolve(true);
  });
  const prepared = {
    location: options.path,
    cleanupAsync: () => snapshotCleanup.operation.result,
    startCleanup: () => snapshotCleanup.operation,
  };
  const preparation = createRetainedOperation<typeof prepared>(() => preparation.resolve(prepared));
  const preparationClose = createRetainedOperation<void>(() => {
    expect(snapshotCleanup.operation.read()).toEqual({ status: "fulfilled", value: true });
    preparationClose.resolve(undefined);
  });
  mock.prepareFresh.mockReturnValueOnce({
    ...preparation.operation,
    startClose: () => preparationClose.operation,
  });
  const completion = owner.run("fresh", () =>
    withArtifactPreservingStateReads(() =>
      executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
    ),
  );
  ready = true;
  let microtaskRan = false;
  queueMicrotask(() => {
    microtaskRan = true;
  });
  observed("fresh").source.service();
  expect(microtaskRan).toBe(false);
  expect(observed("fresh").released).toHaveBeenCalledOnce();
  expect(events).toEqual([
    "admit fresh",
    "release fresh",
    "admit fresh",
    "release fresh",
    "snapshot cleaned",
  ]);
  await expect(completion).resolves.toEqual(reply);
});

it("retains an inherited snapshot until its outer owner closes after the query", async () => {
  const observed = observeReaders();
  const options = source();
  const snapshotCleanup = vi.fn(async () => true);
  mock.prepareInherited.mockResolvedValueOnce({
    location: options.path,
    cleanup: () => true,
    cleanupAsync: snapshotCleanup,
  });
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    const completion = owner.run("inherited", () =>
      executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
    );
    ready = true;
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    observed("inherited").source.service();
    expect(microtaskRan).toBe(false);
    expect(observed("inherited").released).toHaveBeenCalledOnce();
    expect(events).toEqual(["admit inherited", "release inherited"]);
    expect(snapshotCleanup).not.toHaveBeenCalled();
    await expect(completion).resolves.toEqual(reply);
  }, options);
  expect(snapshotCleanup).toHaveBeenCalledOnce();
  expect(mock.prepareFresh).not.toHaveBeenCalled();
  expect(mock.borrow).not.toHaveBeenCalled();
});

it("retains failed preparation custody through a pending close and canonical retry", async () => {
  const observed = observeReaders();
  const options = source();
  const preparationFailure = new Error("snapshot preparation failed after admission");
  const closeFailure = new Error("snapshot producer has not joined");
  const mapped = new Error("mapped preparation failure");
  const mapError = vi.fn(() => mapped);
  const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
  const firstClose = createRetainedOperation<void>(() => {});
  const retryClose = createRetainedOperation<void>(() => {});
  const retryStarted = createDeferredCore();
  const startClose = vi
    .fn()
    .mockReturnValueOnce(firstClose.operation)
    .mockImplementation(() => {
      retryStarted.resolve();
      return retryClose.operation;
    });
  mock.prepareFresh.mockReturnValueOnce({ ...preparation.operation, startClose });
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const handleClosed = vi.fn();
  maintenance.own({}, "shared-handles", handleClosed);
  let maintenanceClose: Promise<void> | undefined;
  let canonicalClose: Promise<unknown> | undefined;
  let completion: ReturnType<typeof executeExistingOpenClawStateRead> | undefined;
  let readSettled = false;
  ready = true;
  try {
    completion = maintenance.run(() =>
      withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(options, { type: "fleet.list" }, { mapError }),
      ),
    );
    void completion.then(
      () => {
        readSettled = true;
      },
      () => {
        readSettled = true;
      },
    );
    const reader = observed();
    preparation.reject(preparationFailure);
    reader.source.service();
    expect(readSettled).toBe(false);
    expect(mapError).not.toHaveBeenCalled();
    expect(startClose).toHaveBeenCalledOnce();
    expect(reader.released).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1); // Admission only; preparation never yielded a query location.
    maintenanceClose = maintenance.close();
    expect(handleClosed).not.toHaveBeenCalled();

    firstClose.reject(closeFailure);
    reader.source.service();
    expect(mapError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cause: preparationFailure,
        errors: [preparationFailure, closeFailure],
      }),
      "before-read",
    );
    expect(reader.released).not.toHaveBeenCalled();
    canonicalClose = closeOpenClawStateDatabaseByPathAsync(options.path);
    await retryStarted.promise;
    expect(startClose).toHaveBeenCalledTimes(2);
    expect(mock.prepareFresh).toHaveBeenCalledOnce();
    expect(reader.released).not.toHaveBeenCalled();
    expect(handleClosed).not.toHaveBeenCalled();

    retryClose.resolve(undefined);
    reader.source.service();
    await canonicalClose;
    await maintenanceClose;
    expect(reader.released).toHaveBeenCalledOnce();
    expect(handleClosed).toHaveBeenCalledOnce();
    await expect(completion).rejects.toBe(mapped);
    expect(mapError).toHaveBeenCalledOnce();
  } finally {
    preparation.reject(preparationFailure);
    firstClose.resolve(undefined);
    retryClose.resolve(undefined);
    if (completion) {
      observed().source.service();
    }
    await Promise.allSettled([canonicalClose, maintenanceClose, maintenance.close(), completion]);
  }
});
