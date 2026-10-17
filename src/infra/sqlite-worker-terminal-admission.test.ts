import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearOpenClawStateDatabaseOpenFailure as clearFailure,
  closeOpenClawStateDatabaseAsync as closeDatabase,
  getOpenClawStateDatabaseTerminalFailureAsync as terminalFailure,
  isOpenClawStateDatabaseOpen as isOpen,
  recordOpenClawStateDatabaseOpenFailure as recordFailure,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker as execute,
  runOpenClawStateWorkerOperation as runOperation,
} from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as fileDescriptor from "./file-descriptor.js";
import { readStableSqliteFileGeneration as readGeneration } from "./sqlite-file-generation.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";

const paths: string[] = [];
const readOp = { type: "plugins.conversationBindingApprovals.read", input: undefined } as const;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    paths.splice(0).forEach(clearFailure);
    cleanup();
  }),
);

function fixture() {
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-terminal-admission-") };
  const capture = () => captureOpenClawStateWorkerContext({ env });
  const pathname = capture().admission.databasePath;
  paths.push(pathname);
  return {
    capture,
    pathname,
    read: () => execute(capture(), readOp),
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

it.each([false, true])("clears failures (existingOnly=%s)", async (existingOnly) => {
  const state = fixture();
  const inspect = vi.fn(async () => "unexpected domain call");
  const read = existingOnly
    ? () => runOperation(state.capture(), inspect, { existingOnly: true })
    : state.read;
  await withoutMainDatabaseWork(async () => {
    if (!existingOnly) {
      expect(await read()).toEqual([]);
    }
    expect(isOpen(state.pathname)).toBe(false);
    const failure = new Error("verified shared-state failure");
    expect(recordFailure(state.pathname, failure)).toBe(true);
    await expect(read()).rejects.toBe(failure);
    expect(existsSync(state.pathname)).toBe(!existingOnly);
    clearFailure(state.pathname);
    expect(await read()).toEqual(existingOnly ? undefined : []);
    expect(isOpen(state.pathname)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(existsSync(state.pathname)).toBe(!existingOnly);
  });
});

it("retains a terminal fact when worker inspection fails, then recovers after a stable mismatch", async () => {
  const state = fixture();
  expect(await state.read()).toEqual([]);
  await closeDatabase();
  const failure = new Error("generation awaiting successful inspection");
  expect(recordFailure(state.pathname, failure, readGeneration(state.pathname))).toBe(true);
  const wal = `${state.pathname}-wal`;
  mkdirSync(wal);
  try {
    await withoutMainDatabaseWork(async () => {
      await expect(terminalFailure(state.capture())).rejects.toBeInstanceOf(Error);
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
    expect(isOpen(state.pathname)).toBe(false);
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
  const active = runOperation(state.capture(), (scope) => scope.execute(readOp));
  let queued: Promise<unknown> | undefined;
  try {
    await replyReady.promise;
    queued = runOperation(state.capture(), (scope) => {
      const reading = scope.execute(readOp);
      queuedReady.resolve();
      return reading;
    });
    const outcomes = Promise.allSettled([active, queued]);
    await queuedReady.promise;
    recordFailure(state.pathname, new Error("parent terminal record"));
    clearFailure(state.pathname);
    publish?.();
    publish = undefined;
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: [] },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: expect.stringContaining("read admission") }),
      },
    ]);
    await closeDatabase();
    expect(requests.mock.calls.filter(([request]) => request.type === "execute")).toHaveLength(1);
    expect(await state.read()).toEqual([]);
  } finally {
    replies.mockRestore();
    publish?.();
    requests.mockRestore();
    await Promise.allSettled([active, queued]);
  }
});
