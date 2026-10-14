// oxfmt-ignore
import { mock, queueTask, source } from "../state/openclaw-state-read-worker.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { readChannelAllowFromStore } from "./pairing-store.read.js";

function pairingSource() {
  const fixture = source();
  const pathname = resolveOpenClawStateSqlitePath(fixture.options.env);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.renameSync(fixture.pathname, pathname);
  return { env: fixture.options.env, pathname };
}

it("retains typed worker refusal through cleanup without replaying the read", async () => {
  const { env } = pairingSource();
  const task = queueTask();
  const cleanupEntered = createDeferredCore();
  const releaseCleanup = createDeferredCore();
  task.close.mockImplementationOnce(() => {
    cleanupEntered.resolve();
    return releaseCleanup.promise;
  });
  const failure = new SqliteSchemaVersionError("newer pairing store");
  const result = readChannelAllowFromStore("demo", env, "alpha");
  const rejected = expect(result).rejects.toBeInstanceOf(SqliteSchemaVersionError);
  try {
    await task.captured;
    task.result.resolve({
      ok: false,
      message: failure.message,
      error: encodeOpenClawStateWorkerError(failure),
    });
    await cleanupEntered.promise;
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup.resolve();
    await rejected;
    expect(mock.runTask).toHaveBeenCalledOnce();
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  } finally {
    releaseCleanup.resolve();
    await rejected;
  }
});

it("refuses replacement of the captured store before queued dispatch", async () => {
  const { env, pathname } = pairingSource();
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = readChannelAllowFromStore("demo", env, "alpha");
  const rejected = expect(result).rejects.toThrow();
  try {
    await task.submitted;
    fs.renameSync(pathname, `${pathname}.retired`);
    fs.writeFileSync(pathname, "successor store");
    dispatch.resolve();
    await rejected;
    await expect(task.captured).rejects.toThrow();
    expect(mock.runTask).toHaveBeenCalledOnce();
  } finally {
    dispatch.resolve();
    await rejected;
  }
});

it("propagates a lost worker result without replay or a native fallback", async () => {
  const { env } = pairingSource();
  const task = queueTask();
  const result = readChannelAllowFromStore("demo", env, "alpha");
  const failure = new WorkerTaskError("reader result lost after dispatch", "unavailable");
  const rejected = expect(result).rejects.toBe(failure);
  await task.captured;
  task.result.reject(failure);
  await rejected;
  expect(mock.runTask).toHaveBeenCalledOnce();
  expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
});
