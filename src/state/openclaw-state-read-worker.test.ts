import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";

type MockPool = {
  run: ReturnType<typeof vi.fn<() => Promise<OpenClawStateReadReply>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  notify?: (error: unknown) => void | Promise<void>;
};
const mock = vi.hoisted((): MockPool => ({ run: vi.fn(), close: vi.fn() }));
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskPool: class {
    constructor(options: { onRetirementFailure?: MockPool["notify"] }) {
      mock.notify = options.onRetirementFailure;
    }
    run = mock.run;
    close = mock.close;
  },
}));

import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    mock.close.mockResolvedValue();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each([false, true])(
  "preserves the raw task failure when retirement fails before acknowledging stop (retry fails=%s)",
  async (retryFails) => {
    mock.run.mockReset();
    mock.close.mockReset();
    const root = tempDirs.make("openclaw-read-task-failure-");
    const pathname = path.join(root, "source.sqlite");
    // Only filesystem identity is consulted; the worker pool is entirely mocked.
    fs.writeFileSync(pathname, "mock worker source");
    const started = createDeferredCore();
    const task = createDeferredCore<OpenClawStateReadReply>();
    const original = new Error("original worker task failed");
    const retirement = new Error("first worker stop failed");
    const retryFailure = new Error("second worker stop failed");
    mock.run.mockImplementation(() => {
      started.resolve();
      return task.promise;
    });
    mock.close.mockResolvedValue();
    if (retryFails) {
      mock.close.mockRejectedValueOnce(retryFailure);
    }

    const result = executeExistingOpenClawStateRead(
      { path: pathname, env: { OPENCLAW_STATE_DIR: root } },
      { type: "fleet.list" },
    );
    const assertion = expect(result).rejects.toMatchObject({
      cause: original,
      errors: [original, retirement, ...(retryFails ? [retryFailure] : [])],
    });
    await started.promise;
    const notification = mock.notify?.(retirement);
    task.reject(original);
    await notification;
    await assertion;
    expect(mock.close).toHaveBeenCalledTimes(1);
    await closeOpenClawStateDatabaseAsync();
    expect(mock.close).toHaveBeenCalledTimes(retryFails ? 2 : 1);
    expect(mock.run).toHaveBeenCalledTimes(1);
  },
);
