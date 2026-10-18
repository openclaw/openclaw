import { AsyncLocalStorage } from "node:async_hooks";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { createOwnedWorkerTaskPoolMock } from "../infra/worker-task-pool.mock.test-support.js";
import type { WorkerTaskInput } from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectCalls, makeReadSource } from "./openclaw-state-db-fixtures.test-support.js";
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

import { createOpenClawDatabaseMaintenanceScope as createMaintenance } from "./openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync as closePath } from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead as readExisting,
  withArtifactPreservingStateReads as preserveArtifacts,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseForTest as resetState,
} from "./openclaw-state-db.js";
import * as readWorker from "./openclaw-state-read-worker.js";

let taskCount = 0;
const releaseFixtures: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of releaseFixtures.splice(0)) {
      release();
    }
    await closeState();
    resetState();
    vi.restoreAllMocks();
    cleanup();
  }),
);

beforeEach(() => {
  taskCount = 0;
  mock.borrow.mockReset();
  mock.prepareNative.mockReset();
  mock.prepareFresh.mockReset();
  mock.prepareInherited.mockReset();
  mock.pool.mockReset().mockImplementation(() =>
    createOwnedWorkerTaskPoolMock<OpenClawStateReadRequest, OpenClawStateReadReply>({
      startTask(input: WorkerTaskInput<OpenClawStateReadRequest>) {
        const inContext = AsyncLocalStorage.snapshot();
        const completion = createRetainedOperation<OpenClawStateReadReply>(() => {
          if (completion.operation.read().status !== "pending") {
            return;
          }
          const request = typeof input === "function" ? input() : input;
          if (request instanceof Promise) {
            throw new Error("This worker fixture requires synchronous admission");
          }
          expect(request.command.type).toBe("admit");
          completion.resolve({ ok: true, type: "admit" });
        });
        const cleanup = createRetainedOperation<void>(() => {
          completion.operation.service();
          if (completion.operation.read().status === "pending") {
            return;
          }
          cleanup.resolve(undefined);
        });
        const task = { ...completion.operation, release: () => cleanup.operation };
        taskCount++;
        releaseFixtures.push(() =>
          inContext(() => {
            task.service();
            task.release().service();
          }),
        );
        return task;
      },
    }),
  );
});

function observeReaderRelease() {
  const captureSource = readWorker.captureOpenClawStateReadSource;
  const released = vi.fn();
  vi.spyOn(readWorker, "captureOpenClawStateReadSource").mockImplementation(() => {
    const capturedSource = captureSource();
    return {
      ...capturedSource,
      own(close) {
        const unregister = capturedSource.own(close);
        return () => {
          unregister();
          released();
        };
      },
    };
  });
  return released;
}

it("retains failed preparation custody through a pending close and canonical retry", async () => {
  const released = observeReaderRelease();
  const options = makeReadSource(tempDirs, "openclaw-retained-read-");
  const preparationFailure = new Error("snapshot preparation failed after admission");
  const closeFailure = new Error("snapshot producer has not joined");
  const mapped = new Error("mapped preparation failure");
  const mapError = vi.fn(() => mapped);
  const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
  const firstClose = createRetainedOperation<void>(() => {});
  const retryClose = createRetainedOperation<void>(() => {});
  const firstStarted = createDeferredCore();
  const retryStarted = createDeferredCore();
  const startClose = vi
    .fn()
    .mockImplementationOnce(() => {
      firstStarted.resolve();
      return firstClose.operation;
    })
    .mockImplementation(() => {
      retryStarted.resolve();
      return retryClose.operation;
    });
  mock.prepareFresh.mockReturnValueOnce({ ...preparation.operation, startClose });
  const maintenance = createMaintenance();
  const handleClosed = vi.fn();
  maintenance.own({}, "shared-handles", handleClosed);
  let maintenanceClose: Promise<void> | undefined;
  let canonicalClose: Promise<unknown> | undefined;
  let completion: ReturnType<typeof readExisting> | undefined;
  const settled = vi.fn();
  try {
    completion = maintenance.run(() =>
      preserveArtifacts(() => readExisting(options, { type: "backup.runs" }, { mapError })),
    );
    void completion.then(settled, settled);
    preparation.reject(preparationFailure);
    await firstStarted.promise;
    expectCalls(0, settled, mapError, released);
    expect(startClose).toHaveBeenCalledOnce();
    expect(taskCount).toBe(1); // Admission only; preparation never yielded a query location.
    maintenanceClose = maintenance.close();
    expect(handleClosed).not.toHaveBeenCalled();

    firstClose.reject(closeFailure);
    await expect(completion).rejects.toBe(mapped);
    expect(mapError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cause: preparationFailure,
        errors: [preparationFailure, closeFailure],
      }),
      "before-read",
    );
    expect(released).not.toHaveBeenCalled();
    canonicalClose = closePath(options.path);
    await retryStarted.promise;
    expect(startClose).toHaveBeenCalledTimes(2);
    expect(mock.prepareFresh).toHaveBeenCalledOnce();
    expectCalls(0, released, handleClosed);

    retryClose.resolve(undefined);
    await canonicalClose;
    await maintenanceClose;
    expectCalls(1, released, handleClosed);
    await expect(completion).rejects.toBe(mapped);
    expect(mapError).toHaveBeenCalledOnce();
  } finally {
    preparation.reject(preparationFailure);
    firstClose.resolve(undefined);
    retryClose.resolve(undefined);
    await Promise.allSettled([canonicalClose, maintenanceClose, maintenance.close(), completion]);
  }
});
