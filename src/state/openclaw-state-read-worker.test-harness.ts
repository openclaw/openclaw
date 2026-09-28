import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  OwnedWorkerTask,
  WorkerTaskInput,
  WorkerTaskOptions,
} from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type ReadTask = OwnedWorkerTask<OpenClawStateReadReply>;
type RunTask = (
  input: WorkerTaskInput<OpenClawStateReadRequest>,
  options: WorkerTaskOptions<OpenClawStateReadRequest>,
) => ReadTask;
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  runTask: vi.fn<RunTask>(),
  closePool: vi.fn<() => Promise<void>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  selectSqlite:
    vi.fn<typeof import("../infra/bun-sqlite-library.js").ensureSqliteLibrarySelected>(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: mock.selectSqlite,
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
beforeEach(() => {
  mock.selectSqlite.mockReset().mockReturnValue({ source: "runtime" });
  mock.runTask.mockReset();
  mock.closePool.mockReset().mockResolvedValue();
  mock.closeResources.mockReset().mockResolvedValue();
  mock.create.mockReset().mockImplementation(() => ({
    runTask: mock.runTask,
    close: mock.closePool,
    closeResources: mock.closeResources,
  }));
});

export function source(name = "source.sqlite") {
  const root = tempDirs.make("openclaw-read-owned-task-");
  const pathname = path.join(root, name);
  // Only filesystem identity is real; no mocked task opens SQLite.
  fs.writeFileSync(pathname, "mock worker source");
  return { root, pathname, options: { path: pathname, env: { OPENCLAW_STATE_DIR: root } } };
}

export function queueTask(dispatchReady: Promise<void> = Promise.resolve()) {
  const result = createDeferredCore<OpenClawStateReadReply>();
  const submitted = createDeferredCore<WorkerTaskOptions<OpenClawStateReadRequest>>();
  const captured = createDeferredCore<OpenClawStateReadRequest>();
  const close = vi.fn<ReadTask["close"]>().mockResolvedValue();
  const handle: ReadTask = { result: result.promise, close };
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
