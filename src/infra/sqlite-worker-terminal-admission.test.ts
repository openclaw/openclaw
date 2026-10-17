import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as fileDescriptor from "./file-descriptor.js";
import { readStableSqliteFileGeneration } from "./sqlite-file-generation.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";

const paths = new Set<string>();
const readCommand = {
  type: "plugins.conversationBindingApprovals.read",
  input: undefined,
} as const;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    for (const pathname of paths) {
      clearOpenClawStateDatabaseOpenFailure(pathname);
    }
    paths.clear();
    cleanup();
  }),
);

function fixture() {
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-terminal-admission-") };
  const capture = () => captureOpenClawStateWorkerContext({ env });
  const pathname = capture().admission.databasePath;
  paths.add(pathname);
  return {
    capture,
    pathname,
    read: () => executeOpenClawStateWorker(capture(), readCommand),
  };
}

async function withoutMainDatabaseWork(run: () => Promise<void>) {
  const sql = observeMainThreadSql();
  const hash = vi.spyOn(fileDescriptor, "hashFileDescriptorSync");
  try {
    await run();
    sql.expectIdle();
    expect(hash).not.toHaveBeenCalled();
  } finally {
    sql.restore();
    hash.mockRestore();
  }
}

it.each([false, true])(
  "rejects a recorded failure and recovers on clear (existing-only: %s)",
  async (existingOnly) => {
    const state = fixture();
    const inspect = vi.fn(async () => "unexpected domain call");
    const read = existingOnly
      ? () => runOpenClawStateWorkerOperation(state.capture(), inspect, { existingOnly: true })
      : state.read;
    await withoutMainDatabaseWork(async () => {
      if (!existingOnly) {
        expect(await read()).toEqual([]);
      }
      expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
      const failure = new Error("verified shared-state failure");
      expect(recordOpenClawStateDatabaseOpenFailure(state.pathname, failure)).toBe(true);
      await expect(read()).rejects.toBe(failure);
      if (existingOnly) {
        expect(existsSync(state.pathname)).toBe(false);
      }
      clearOpenClawStateDatabaseOpenFailure(state.pathname);
      expect(await read()).toEqual(existingOnly ? undefined : []);
      expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
      if (existingOnly) {
        expect(existsSync(state.pathname)).toBe(false);
      }
    });
  },
);

it("retains a terminal fact when worker inspection fails, then recovers after a stable mismatch", async () => {
  const state = fixture();
  expect(await state.read()).toEqual([]);
  await closeOpenClawStateDatabaseAsync();
  const failure = new Error("generation awaiting successful inspection");
  expect(
    recordOpenClawStateDatabaseOpenFailure(
      state.pathname,
      failure,
      readStableSqliteFileGeneration(state.pathname),
    ),
  ).toBe(true);
  const { getOpenClawStateDatabaseTerminalFailureAsync } =
    await import("../state/openclaw-state-db-cache.js");
  const wal = `${state.pathname}-wal`;
  mkdirSync(wal);
  try {
    await withoutMainDatabaseWork(async () => {
      await expect(
        getOpenClawStateDatabaseTerminalFailureAsync(state.capture()),
      ).rejects.toBeInstanceOf(Error);
    });
  } finally {
    rmdirSync(wal);
  }
  // Removing the unreadable sidecar leaves the original recorded generation intact.
  await withoutMainDatabaseWork(async () => {
    await expect(state.read()).rejects.toBe(failure);
  });
  const database = new DatabaseSync(state.pathname);
  try {
    database.exec("PRAGMA application_id = 321");
  } finally {
    database.close();
  }
  await withoutMainDatabaseWork(async () => {
    expect(await state.read()).toEqual([]);
    expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
  });
});

it("rejects a queued domain job before dispatch after record and clear while completing the dispatched read", async () => {
  const state = fixture();
  expect(await state.read()).toEqual([]);
  const replyReady = createDeferred();
  const queuedReady = createDeferred();
  let publish: (() => void) | undefined;
  const replies = vi.spyOn(Worker.prototype, "emit").mockImplementationOnce(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    replies.mockRestore();
    publish = () => this.emit(event, reply);
    replyReady.resolve();
    return true;
  });
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const active = runOpenClawStateWorkerOperation(state.capture(), (scope) =>
    scope.execute(readCommand),
  );
  let queued: Promise<unknown> | undefined;
  let draining: Promise<void> | undefined;
  try {
    await replyReady.promise;
    queued = runOpenClawStateWorkerOperation(state.capture(), (scope) => {
      const reading = scope.execute(readCommand);
      queuedReady.resolve();
      return reading;
    });
    const outcomes = Promise.allSettled([active, queued]);
    await queuedReady.promise;
    recordOpenClawStateDatabaseOpenFailure(state.pathname, new Error("parent terminal record"));
    clearOpenClawStateDatabaseOpenFailure(state.pathname);
    publish?.();
    publish = undefined;
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: [] },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("read admission") }),
      },
    ]);
    draining = closeOpenClawStateDatabaseAsync();
    await draining;
    expect(requests.mock.calls.filter(([request]) => request.type === "execute")).toHaveLength(1);
    requests.mockRestore();
    expect(await state.read()).toEqual([]);
  } finally {
    replies.mockRestore();
    publish?.();
    requests.mockRestore();
    await Promise.allSettled([active, queued, draining]);
  }
});
