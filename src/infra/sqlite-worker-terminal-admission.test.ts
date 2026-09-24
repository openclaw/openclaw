import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as fileDescriptor from "./file-descriptor.js";
import { readStableSqliteFileGeneration } from "./sqlite-file-generation.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";

const paths = new Set<string>();
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
    read: () =>
      executeOpenClawStateWorker(capture(), {
        type: "tasks.list",
        input: { ownerKey: "agent:main:main" },
      }),
  };
}

function observeMainDatabaseWork() {
  const calls = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    vi.spyOn(fileDescriptor, "hashFileDescriptorSync"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  return {
    expectIdle: () => {
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    },
    restore: () => {
      for (const call of calls) {
        call.mockRestore();
      }
    },
  };
}

describe("shared-state worker terminal admission", () => {
  it("rejects fresh domain reads after a parent failure with only a worker open, then recovers on clear", async () => {
    const state = fixture();
    const main = observeMainDatabaseWork();
    try {
      expect(await state.read()).toEqual([]);
      expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
      const failure = new Error("verified shared-state failure");
      expect(recordOpenClawStateDatabaseOpenFailure(state.pathname, failure)).toBe(true);
      await expect(state.read()).rejects.toBe(failure);
      clearOpenClawStateDatabaseOpenFailure(state.pathname);
      expect(await state.read()).toEqual([]);
      expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
      main.expectIdle();
    } finally {
      main.restore();
    }
  });

  it.each(["explicit clear", "same-file update"] as const)(
    "validates a recorded generation off-thread and admits a later read after %s",
    async (recovery) => {
      const state = fixture();
      expect(await state.read()).toEqual([]);
      await closeOpenClawStateDatabaseAsync();
      const failure = new Error("generation-bound shared-state failure");
      expect(
        recordOpenClawStateDatabaseOpenFailure(
          state.pathname,
          failure,
          readStableSqliteFileGeneration(state.pathname),
        ),
      ).toBe(true);
      let main = observeMainDatabaseWork();
      try {
        await expect(state.read()).rejects.toBe(failure);
        main.expectIdle();
        main.restore();
        if (recovery === "explicit clear") {
          clearOpenClawStateDatabaseOpenFailure(state.pathname);
        } else {
          // Change the existing file through SQLite without changing its schema or pathname.
          const database = new DatabaseSync(state.pathname);
          try {
            database.exec("PRAGMA application_id = 123");
          } finally {
            database.close();
          }
        }
        main = observeMainDatabaseWork();
        expect(await state.read()).toEqual([]);
        expect(isOpenClawStateDatabaseOpen(state.pathname)).toBe(false);
        main.expectIdle();
      } finally {
        main.restore();
      }
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
    const main = observeMainDatabaseWork();
    try {
      await expect(
        getOpenClawStateDatabaseTerminalFailureAsync(state.capture()),
      ).rejects.toBeInstanceOf(Error);
      main.expectIdle();
    } finally {
      main.restore();
      rmdirSync(wal);
    }
    // Removing the unreadable sidecar leaves the original recorded generation intact.
    await expect(getOpenClawStateDatabaseTerminalFailureAsync(state.capture())).resolves.toBe(
      failure,
    );
    const database = new DatabaseSync(state.pathname);
    try {
      database.exec("PRAGMA application_id = 321");
    } finally {
      database.close();
    }
    expect(await state.read()).toEqual([]);
  });

  it("does not create absent state while checking a recorded failure or an existing-only read", async () => {
    const state = fixture();
    const failure = new Error("recorded failure before first open");
    recordOpenClawStateDatabaseOpenFailure(state.pathname, failure);
    const inspect = vi.fn(async () => "unexpected domain call");
    const main = observeMainDatabaseWork();
    try {
      await expect(
        runOpenClawStateWorkerOperation(state.capture(), inspect, { existingOnly: true }),
      ).rejects.toBe(failure);
      expect(existsSync(state.pathname)).toBe(false);
      clearOpenClawStateDatabaseOpenFailure(state.pathname);
      expect(
        await runOpenClawStateWorkerOperation(state.capture(), inspect, { existingOnly: true }),
      ).toBeUndefined();
      expect(inspect).not.toHaveBeenCalled();
      expect(existsSync(state.pathname)).toBe(false);
      main.expectIdle();
    } finally {
      main.restore();
    }
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
      scope.execute({ type: "tasks.list", input: { ownerKey: "active" } }),
    );
    let queued: Promise<unknown> | undefined;
    let draining: Promise<void> | undefined;
    try {
      await replyReady.promise;
      queued = runOpenClawStateWorkerOperation(state.capture(), (scope) => {
        const reading = scope.execute({ type: "tasks.list", input: { ownerKey: "queued" } });
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
});
