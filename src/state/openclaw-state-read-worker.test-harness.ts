import fs from "node:fs";
import path from "node:path";
import type { OwnedWorkerTask } from "@openclaw/worker-runtime";
import {
  createRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOwnedWorkerTaskPoolMock } from "../infra/worker-task-pool.mock.test-support.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type ReadTask = RetainedOperation<OpenClawStateReadReply> & {
  release(options?: { retire?: true }): RetainedOperation<void>;
};
type RunTask = (
  input: WorkerTaskInput<OpenClawStateReadRequest>,
  options: WorkerTaskOptions<OpenClawStateReadRequest>,
) => ReadTask;
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  runTask: vi.fn<RunTask>(),
  closePool: vi.fn<() => Promise<void>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  rotate: vi.fn<() => Promise<void>>(),
  selectSqlite:
    vi.fn<typeof import("../infra/bun-sqlite-library.js").ensureSqliteLibrarySelected>(),
  capabilities:
    vi.fn<typeof import("../infra/bun-sqlite-library.js").getSqliteRuntimeCapabilities>(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: mock.selectSqlite,
  getSqliteRuntimeCapabilities: mock.capabilities,
}));
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: mock.create,
}));

import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

export { mock };

const taskCleanups: Array<() => void> = [];
export const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of taskCleanups.splice(0)) {
      release();
    }
    mock.closePool.mockReset().mockResolvedValue();
    mock.closeResources.mockReset().mockResolvedValue();
    mock.rotate.mockReset().mockResolvedValue();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
beforeEach(() => {
  mock.selectSqlite.mockReset().mockReturnValue({ source: "runtime" });
  mock.capabilities.mockReset().mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: true,
    decided: true,
    reason: "test policy",
  });
  mock.runTask.mockReset();
  mock.closePool.mockReset().mockResolvedValue();
  mock.closeResources.mockReset().mockResolvedValue();
  mock.rotate.mockReset().mockResolvedValue();
  mock.create.mockReset().mockImplementation(() =>
    createOwnedWorkerTaskPoolMock<OpenClawStateReadRequest, OpenClawStateReadReply>({
      startTask: mock.runTask,
      close: mock.closePool,
      closeResources: mock.closeResources,
      rotate: mock.rotate,
    }),
  );
});

export function source(name = "source.sqlite") {
  const root = tempDirs.make("openclaw-read-owned-task-");
  const pathname = path.join(root, name);
  // Only filesystem identity is real; no mocked task opens SQLite.
  fs.writeFileSync(pathname, "mock worker source");
  return { root, pathname, options: { path: pathname, env: { OPENCLAW_STATE_DIR: root } } };
}

export function queueTask(dispatchReady: Promise<void> = Promise.resolve()) {
  const completion = createRetainedOperation<OpenClawStateReadReply>(() => {});
  const result = {
    promise: completion.operation.result,
    resolve: completion.resolve,
    reject: completion.reject,
  };
  const submitted = createDeferredCore<WorkerTaskOptions<OpenClawStateReadRequest>>();
  const captured = createDeferredCore<OpenClawStateReadRequest>();
  const close = vi.fn<OwnedWorkerTask<OpenClawStateReadReply>["close"]>().mockResolvedValue();
  const handle: ReadTask = {
    ...completion.operation,
    release(options) {
      const closed = createRetainedOperation<void>(() => {});
      void close(options).then(closed.resolve, closed.reject);
      return closed.operation;
    },
  };
  let detach = () => {};
  mock.runTask.mockImplementationOnce((input, options) => {
    const signal = options.signal;
    const abort = () => result.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    detach = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) {
      abort();
    }
    submitted.resolve(options);
    void dispatchReady
      .then(async () => {
        const request = typeof input === "function" ? await input() : input;
        captured.resolve(request);
      })
      .catch((error: unknown) => {
        captured.reject(error);
        result.reject(error);
      });
    return handle;
  });
  void captured.promise.catch(() => undefined);
  taskCleanups.push(() => {
    detach();
    close.mockReset().mockResolvedValue();
    result.reject(new Error("test task cleanup"));
  });
  return { result, submitted: submitted.promise, captured: captured.promise, close };
}

export const emptyReply: OpenClawStateReadReply = {
  ok: true,
  type: "fleet.list",
  sourceAdmitted: true,
  cells: [],
};
