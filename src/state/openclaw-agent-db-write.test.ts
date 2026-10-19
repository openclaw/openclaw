import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainStoreWriterQueuesForTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as databasePathIdentity from "../infra/sqlite-worker-identity.js";
import { withOpenClawAgentDatabaseWrite as writeDatabase } from "../plugin-sdk/sqlite-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  borrowOpenClawAgentDatabase as borrowDatabase,
  closeOpenClawAgentDatabasesForTest as closeDatabases,
  getOpenClawAgentDatabaseIfOpen as getOpenDatabase,
  openOpenClawAgentDatabase as openDatabase,
} from "./openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "./openclaw-agent-write-admission-state.js";
import {
  runOpenClawAgentWorkerWrite as workerWrite,
  runOpenClawAgentWriteAdmission as admitWrite,
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
    closeDatabases();
  });

  function reserveWorkerOperation(start?: () => void, workerOptions = options) {
    const entered = createDeferredCore();
    const settled = createDeferredCore();
    releases.push(settled.resolve);
    const done = workerWrite(workerOptions, async () => {
      start?.();
      entered.resolve();
      await settled.promise;
    });
    return {
      entered: entered.promise,
      done,
      release: settled.resolve,
      finish: async () => {
        settled.resolve();
        await done;
      },
    };
  }

  function aliasFixture() {
    const directory = path.dirname(options.path);
    const alias = path.join(directory, "alias");
    const successor = path.join(directory, "successor");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(directory, alias, linkType);
    return {
      successor,
      aliased: { ...options, path: path.join(alias, path.basename(options.path)) },
      other: { ...options, path: path.join(successor, path.basename(options.path)) },
      retarget: () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(successor, alias, linkType);
      },
    };
  }

  it.each(["stable", "retargeted"] as const)(
    "preserves FIFO and rejects stale worker reservation through a %s alias",
    async (target) => {
      const { successor, aliased, retarget } = aliasFixture();
      const capture = databasePathIdentity.readDatabasePathIdentitySync.bind(databasePathIdentity);
      const identity =
        target === "retargeted"
          ? vi
              .spyOn(databasePathIdentity, "readDatabasePathIdentitySync")
              .mockImplementationOnce((pathname) => {
                const observed = capture(pathname);
                // Move the alias between its captured identity and worker reservation.
                fs.mkdirSync(successor);
                retarget();
                return observed;
              })
          : undefined;
      const calls: number[] = [];
      const writes: Promise<number>[] = [];
      const reservation = reserveWorkerOperation(() => {
        for (const value of [1, 2, 3]) {
          writes.push(
            writeDatabase(value === 2 ? aliased : options, () => {
              calls.push(value);
              return value;
            }),
          );
        }
      }, aliased);
      try {
        if (target === "retargeted") {
          reservation.release();
          await expect(reservation.done).rejects.toThrow("database target changed");
          expect(writes).toEqual([]);
          return;
        }
        await reservation.entered;
        await setImmediate();
        expect(calls).toEqual([]);
      } finally {
        identity?.mockRestore();
        reservation.release();
        await reservation.done.catch(() => undefined);
        await Promise.all(writes);
      }
      await expect(Promise.all(writes)).resolves.toEqual([1, 2, 3]);
      expect(calls).toEqual([1, 2, 3]);
    },
  );

  it("retains caller context and lets synchronous mutations reenter the ordinary owner", async () => {
    const caller = new AsyncLocalStorage<string>();
    const reservation = reserveWorkerOperation();
    await reservation.entered;
    const write = caller.run("foreground-owner", () =>
      admitWrite(options, () => writeDatabase(options, () => caller.getStore())),
    );
    await reservation.finish();
    await expect(write).resolves.toBe("foreground-owner");
  });

  it.each(["cold", "warm", "borrowed", "admission"] as const)(
    "rejects a queued write after its alias retargets without committing to either target (%s)",
    async (mode) => {
      const { successor, aliased, other, retarget } = aliasFixture();
      fs.mkdirSync(successor);
      const original = openDatabase(options);
      const replacement = openDatabase(other);
      for (const database of [original, replacement]) {
        database.db.exec("CREATE TABLE admission_proof (value TEXT NOT NULL) STRICT");
      }
      const borrowed = mode === "borrowed" ? borrowDatabase(aliased) : undefined;
      const borrowedDb = borrowed && requireNativeSqliteDatabase(borrowed.db);
      const commit = (value: string) => (database: typeof original) => {
        database.db.prepare("INSERT INTO admission_proof VALUES (?)").run(value);
      };
      const cold = mode === "cold" || mode === "admission";
      const write = (value: string) =>
        mode === "admission"
          ? admitWrite(aliased, () => commit(value)(openDatabase(aliased)))
          : writeDatabase(aliased, commit(value), borrowedDb);
      if (!cold) {
        await writeDatabase(aliased, commit("before"), borrowedDb);
      }
      const reservation = reserveWorkerOperation();
      await reservation.entered;
      const queued = write("queued");
      const refused = expect(queued).rejects.toThrow("database target changed");
      try {
        retarget();
        const next = write("successor");
        if (cold) {
          await next;
        } else {
          await expect(next).rejects.toThrow("database file identity changed");
        }
      } finally {
        await reservation.finish();
        await Promise.allSettled([queued, refused]);
        borrowed?.release();
      }
      await refused;
      await writeDatabase(options, commit("after"));
      expect(original.db.prepare("SELECT value FROM admission_proof ORDER BY rowid").all()).toEqual(
        (cold ? ["after"] : ["before", "after"]).map((value) => ({ value })),
      );
      expect(
        replacement.db.prepare("SELECT value FROM admission_proof ORDER BY rowid").all(),
      ).toEqual(cold ? [{ value: "successor" }] : []);
    },
  );

  it("rejects a closed borrowed handle without adopting a replacement", async () => {
    const borrowed = borrowDatabase(options);
    const reservation = reserveWorkerOperation();
    await reservation.entered;
    const mutate = vi.fn();
    const write = writeDatabase(options, mutate, requireNativeSqliteDatabase(borrowed.db));
    const rejected = expect(write).rejects.toThrow("Borrowed agent database closed or changed");
    closeDatabases();
    const replacement = openDatabase(options);
    await reservation.finish();
    await rejected;
    expect(mutate).not.toHaveBeenCalled();
    expect(getOpenDatabase(options)).toBe(replacement);
    borrowed.release();
  });

  it.each(["cold", "borrowed", "state directory"] as const)(
    "pins queued relative database and registry paths before cwd changes (%s)",
    async (mode) => {
      const firstDirectory = path.dirname(options.path);
      const secondDirectory = path.join(firstDirectory, "other-cwd");
      const originalState = path.join(firstDirectory, "state");
      const stateDirectory = mode === "state directory";
      const selectedPath = stateDirectory
        ? path.join(originalState, "agents/main/agent/openclaw-agent.sqlite")
        : options.path;
      fs.mkdirSync(secondDirectory);
      const borrowed = mode === "borrowed" ? borrowDatabase(options) : undefined;
      const borrowedDb = borrowed && requireNativeSqliteDatabase(borrowed.db);
      const reservation = reserveWorkerOperation(undefined, { ...options, path: selectedPath });
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(firstDirectory);
      const mutate = vi.fn(
        ({ path: databasePath }: ReturnType<typeof openDatabase>) => databasePath,
      );
      let write: Promise<string> | undefined;
      try {
        await reservation.entered;
        write = writeDatabase(
          stateDirectory
            ? { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: "state" } }
            : { ...options, path: path.basename(options.path) },
          mutate,
          borrowedDb,
        );
        void write.catch(() => {});
        await setImmediate();
        expect(mutate).not.toHaveBeenCalled();
        cwd.mockReturnValue(secondDirectory);
        await reservation.finish();
        await expect(write).resolves.toBe(selectedPath);
        expect(mutate).toHaveBeenCalledOnce();
        expect(fs.existsSync(selectedPath)).toBe(true);
        expect(fs.existsSync(path.join(secondDirectory, path.basename(options.path)))).toBe(false);
        if (stateDirectory) {
          expect(fs.existsSync(path.join(originalState, "state/openclaw.sqlite"))).toBe(true);
          expect(fs.existsSync(path.join(secondDirectory, "state/state/openclaw.sqlite"))).toBe(
            false,
          );
        }
        if (borrowed) {
          expect(getOpenDatabase(options)?.db).toBe(borrowed.db);
        }
      } finally {
        await reservation.finish();
        await write?.catch(() => {});
        cwd.mockRestore();
        borrowed?.release();
      }
    },
  );

  it("joins a mistakenly asynchronous callback before rejecting it or admitting the next writer", async () => {
    const tail = createDeferredCore();
    const entered = createDeferredCore();
    releases.push(tail.resolve);
    const calls: string[] = [];
    const malformed = writeDatabase(options, async () => {
      entered.resolve();
      await tail.promise;
      calls.push("callback settled");
    });
    const rejected = expect(malformed).rejects.toThrow("write callbacks must remain synchronous");
    await entered.promise;
    const next = writeDatabase(options, () => calls.push("next writer"));
    await setImmediate();
    expect(calls).toEqual([]);
    tail.resolve();
    await rejected;
    await next;
    expect(calls).toEqual(["callback settled", "next writer"]);
  });
});
