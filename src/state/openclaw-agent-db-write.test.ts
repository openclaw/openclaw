import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawAgentDatabaseWrite } from "../plugin-sdk/sqlite-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainStoreWriterQueuesForTest } from "../shared/store-writer-queue.js";
import {
  borrowOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
  SQLITE_SESSION_WRITER_QUEUES,
} from "./openclaw-agent-write-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent database write admission", () => {
  let options: { agentId: string; path: string };
  const releases: Array<() => void> = [];

  beforeEach(() => {
    const root = fs.realpathSync(tempDirs.make("openclaw-agent-write-admission-"));
    options = { agentId: "main", path: path.join(root, "openclaw-agent.sqlite") };
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "test cleanup");
    closeOpenClawAgentDatabasesForTest();
  });

  function reserveWorkerOperation(start?: () => void) {
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    releases.push(settled.resolve);
    const done = runOpenClawAgentWorkerWrite(options, async () => {
      start?.();
      entered.resolve();
      await settled.promise;
    });
    return { entered: entered.promise, done, release: settled.resolve };
  }

  it.each(["cold", "warm"] as const)(
    "admits %s writes only after the reserved worker operation settles",
    async (temperature) => {
      const warm = temperature === "warm" ? openOpenClawAgentDatabase(options) : undefined;
      const reservation = reserveWorkerOperation();
      await reservation.entered;
      const mutate = vi.fn(({ db }: ReturnType<typeof openOpenClawAgentDatabase>) => {
        db.exec("CREATE TABLE admission_proof (value TEXT NOT NULL) STRICT");
        db.prepare("INSERT INTO admission_proof VALUES (?)").run("committed");
        return db;
      });
      const write = withOpenClawAgentDatabaseWrite(options, mutate);
      await setImmediate();
      expect(mutate).not.toHaveBeenCalled();
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(warm);
      reservation.release();
      await reservation.done;
      const db = await write;
      expect(mutate).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT value FROM admission_proof").all()).toEqual([
        { value: "committed" },
      ]);
      if (warm) {
        expect(db).toBe(warm.db);
      }
    },
  );

  it("queues inherited worker callbacks without borrowing the worker's reentrancy", async () => {
    const calls: number[] = [];
    const writes: Promise<number>[] = [];
    const reservation = reserveWorkerOperation(() => {
      for (const value of [1, 2, 3]) {
        writes.push(
          withOpenClawAgentDatabaseWrite(options, () => {
            calls.push(value);
            return value;
          }),
        );
      }
    });
    await reservation.entered;
    await setImmediate();
    expect(calls).toEqual([]);
    reservation.release();
    await reservation.done;
    await expect(Promise.all(writes)).resolves.toEqual([1, 2, 3]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("retains caller context and lets synchronous mutations reenter the ordinary owner", async () => {
    const caller = new AsyncLocalStorage<string>();
    const reservation = reserveWorkerOperation();
    await reservation.entered;
    const write = caller.run("foreground-owner", () =>
      runOpenClawAgentWriteAdmission(options, () =>
        withOpenClawAgentDatabaseWrite(options, () => caller.getStore()),
      ),
    );
    reservation.release();
    await reservation.done;
    await expect(write).resolves.toBe("foreground-owner");
  });

  it.each([false, true])(
    "rejects a closed borrowed handle without adopting a replacement (%s)",
    async (replace) => {
      const borrowed = borrowOpenClawAgentDatabase(options);
      const reservation = reserveWorkerOperation();
      await reservation.entered;
      const mutate = vi.fn();
      const write = withOpenClawAgentDatabaseWrite(options, mutate, borrowed.db);
      const rejected = expect(write).rejects.toThrow("Borrowed agent database closed or changed");
      closeOpenClawAgentDatabasesForTest();
      const replacement = replace ? openOpenClawAgentDatabase(options) : undefined;
      reservation.release();
      await reservation.done;
      await rejected;
      expect(mutate).not.toHaveBeenCalled();
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(replacement);
      borrowed.release();
    },
  );

  it.each(["cold", "borrowed"] as const)(
    "pins a queued relative path before cwd changes (%s)",
    async (mode) => {
      const firstDirectory = path.dirname(options.path);
      const secondDirectory = path.join(firstDirectory, "other-cwd");
      fs.mkdirSync(secondDirectory);
      const borrowed = mode === "borrowed" ? borrowOpenClawAgentDatabase(options) : undefined;
      const reservation = reserveWorkerOperation();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(firstDirectory);
      const mutate = vi.fn(
        ({ path: databasePath }: ReturnType<typeof openOpenClawAgentDatabase>) => databasePath,
      );
      let write: Promise<string> | undefined;
      try {
        await reservation.entered;
        write = withOpenClawAgentDatabaseWrite(
          { ...options, path: path.basename(options.path) },
          mutate,
          borrowed?.db,
        );
        void write.catch(() => {});
        await setImmediate();
        expect(mutate).not.toHaveBeenCalled();
        cwd.mockReturnValue(secondDirectory);
        reservation.release();
        await reservation.done;
        await expect(write).resolves.toBe(options.path);
        expect(mutate).toHaveBeenCalledOnce();
        expect(fs.existsSync(options.path)).toBe(true);
        expect(fs.existsSync(path.join(secondDirectory, path.basename(options.path)))).toBe(false);
        if (borrowed) {
          expect(getOpenClawAgentDatabaseIfOpen(options)?.db).toBe(borrowed.db);
        }
      } finally {
        reservation.release();
        await reservation.done;
        await write?.catch(() => {});
        cwd.mockRestore();
        borrowed?.release();
      }
    },
  );

  it("pins a queued relative state directory for registry and lease ownership", async () => {
    const root = path.dirname(options.path);
    const otherCwd = path.join(root, "other-cwd");
    const originalState = path.join(root, "state");
    const selectedPath = path.join(
      originalState,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(otherCwd);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const release = createDeferredCore();
    releases.push(release.resolve);
    const reservation = runOpenClawAgentWorkerWrite(
      { ...options, path: selectedPath },
      async () => release.promise,
    );
    let write: Promise<string> | undefined;
    try {
      write = withOpenClawAgentDatabaseWrite(
        { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: "state" } },
        (database) => database.path,
      );
      void write.catch(() => {});
      await setImmediate();
      cwd.mockReturnValue(otherCwd);
      release.resolve();
      await reservation;
      await expect(write).resolves.toBe(selectedPath);
      expect(fs.existsSync(path.join(originalState, "state", "openclaw.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(otherCwd, "state", "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      release.resolve();
      await reservation;
      await write?.catch(() => {});
      cwd.mockRestore();
    }
  });

  it("rechecks live caller authority after waiting and preserves the original rejection", async () => {
    const reservation = reserveWorkerOperation();
    await reservation.entered;
    let active = true;
    const revoked = new Error("caller authority revoked");
    const committed = vi.fn();
    const write = withOpenClawAgentDatabaseWrite(options, () => {
      if (!active) {
        throw revoked;
      }
      committed();
    });
    const rejected = expect(write).rejects.toBe(revoked);
    active = false;
    reservation.release();
    await reservation.done;
    await rejected;
    expect(committed).not.toHaveBeenCalled();
    await expect(withOpenClawAgentDatabaseWrite(options, () => "next owner")).resolves.toBe(
      "next owner",
    );
  });

  it("does not serialize independent agent database paths behind a reserved worker", async () => {
    const reservation = reserveWorkerOperation();
    await reservation.entered;
    const other = { agentId: "peer", path: path.join(path.dirname(options.path), "peer.sqlite") };
    await expect(withOpenClawAgentDatabaseWrite(other, ({ agentId }) => agentId)).resolves.toBe(
      "peer",
    );
    reservation.release();
    await reservation.done;
  });

  it("joins a mistakenly asynchronous callback before rejecting it or admitting the next writer", async () => {
    const tail = createDeferredCore();
    const entered = createDeferredCore();
    releases.push(tail.resolve);
    const calls: string[] = [];
    const malformed = withOpenClawAgentDatabaseWrite(options, async () => {
      entered.resolve();
      await tail.promise;
      calls.push("callback settled");
    });
    const rejected = expect(malformed).rejects.toThrow("write callbacks must remain synchronous");
    await entered.promise;
    const next = withOpenClawAgentDatabaseWrite(options, () => calls.push("next writer"));
    await setImmediate();
    expect(calls).toEqual([]);
    tail.resolve();
    await rejected;
    await next;
    expect(calls).toEqual(["callback settled", "next writer"]);
  });
});
