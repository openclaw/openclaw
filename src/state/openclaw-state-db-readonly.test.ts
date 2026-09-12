import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import * as sqliteReadOnly from "../infra/sqlite-snapshot-source.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  acquireOpenClawStateDatabaseFileExclusion,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import {
  isArtifactPreservingStateRead,
  iterateOpenClawStateDatabaseReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

function createOptions(stateDir: string) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it("keeps fresh synchronous read callbacks from returning asynchronous work", async () => {
  await withTempDir("openclaw-state-sync-read-", async (root) => {
    const options = createOptions(root);
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    expect(() =>
      withExistingOpenClawStateDatabaseReadOnly(() => Promise.resolve(1), options),
    ).toThrow("SQLite source read must remain synchronous");
    const exclusion = await acquireOpenClawStateDatabaseFileExclusion(options.path);
    exclusion.release();
  });
});

it.each(["complete", "return", "throw"] as const)(
  "ends the native stream snapshot before close on %s",
  async (ending) => {
    await withTempDir("openclaw-state-stream-snapshot-", async (root) => {
      const source = openOpenClawStateDatabase(createOptions(root));
      let reader: DatabaseSync | undefined;
      let finalized = false;
      let transactionAtClose: boolean | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
      const close = DatabaseSync.prototype.close;
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        if (this === reader) {
          transactionAtClose = this.isTransaction;
        }
        close.call(this);
      });
      const rows = iterateOpenClawStateDatabaseReadOnly(source, function* ({ db }) {
        reader = db;
        try {
          yield db.prepare("SELECT 1 AS value").get()?.value;
        } finally {
          expect(db.isOpen).toBe(true);
          expect(db.isTransaction).toBe(true);
          finalized = true;
        }
      });
      try {
        expect((await rows.next()).value).toBe(1);
        if (ending === "complete") {
          expect((await rows.next()).done).toBe(true);
        } else if (ending === "return") {
          await rows.return();
        } else {
          const failure = new Error("stream consumer failed");
          await expect(rows.throw(failure)).rejects.toBe(failure);
        }
        expect(finalized).toBe(true);
        expect(transactionAtClose).toBe(false);
        expect(reader?.isOpen).toBe(false);
      } finally {
        await rows.return();
      }
    });
  },
);

it("retains stream handle custody when native close fails until explicit close succeeds", async () => {
  await withTempDir("openclaw-state-stream-close-", async (root) => {
    const source = openOpenClawStateDatabase(createOptions(root));
    const failure = new Error("reader close failed");
    let refuseClose = true;
    let reader: DatabaseSync | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
    const close = DatabaseSync.prototype.close;
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    closeSpy.mockImplementation(function (this: DatabaseSync) {
      if (this === reader && refuseClose) {
        throw failure;
      }
      close.call(this);
    });
    const rows = iterateOpenClawStateDatabaseReadOnly(source, function* ({ db }) {
      reader = db;
      yield db.prepare("SELECT 1 AS value").get()?.value;
      yield 2;
    });
    try {
      expect((await rows.next()).value).toBe(1);
      await expect(rows.return()).rejects.toBe(failure);
      expect(reader?.isOpen).toBe(true);
      await expect(acquireOpenClawStateDatabaseFileExclusion(source.path)).rejects.toThrow(
        "reader close failed",
      );
      expect(reader?.isOpen).toBe(true);
      refuseClose = false;
      closeOpenClawStateDatabaseForTest();
      expect(reader?.isOpen).toBe(false);
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(source.path);
      exclusion.release();
    } finally {
      refuseClose = false;
      await rows.return();
      closeOpenClawStateDatabaseForTest();
      closeSpy.mockRestore();
    }
  });
});

it("rejects non-filesystem stream sources without interpreting their logical path as a file", async () => {
  await withTempDir("openclaw-state-memory-stream-", async (root) => {
    const db = new DatabaseSync(":memory:");
    const pathname = path.join(root, "logical-state.sqlite");
    const rows = iterateOpenClawStateDatabaseReadOnly(
      { db, path: pathname, walMaintenance: { checkpoint: () => false, close: () => false } },
      function* () {
        yield "unreachable";
      },
    );
    try {
      await expect(rows.next()).rejects.toThrow(
        "Streaming shared-state reads require a filesystem-backed database",
      );
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      await rows.return();
      db.close();
    }
  });
});

it("waits for a transient database lock before a fresh read-only schema inspection", async () => {
  await withTempDir("openclaw-state-readonly-busy-", async (stateDir) => {
    const options = createOptions(stateDir);
    await fsp.mkdir(path.dirname(options.path), { recursive: true });
    const setup = new DatabaseSync(options.path);
    try {
      setup.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed');");
    } finally {
      setup.close();
    }
    const before = fs.readFileSync(options.path);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { DatabaseSync } from "node:sqlite";
          const db = new DatabaseSync(process.argv[1]);
          db.exec("BEGIN EXCLUSIVE; UPDATE held SET value = 'uncommitted';");
          process.once("message", () => {
            setTimeout(() => {
              db.exec("ROLLBACK");
              db.close();
              process.disconnect();
            }, 200);
          });
          process.send({ locked: true });
        `,
        options.path,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      expectDefined(child.stderr, "SQLite lock child stderr pipe").on("data", (chunk) => {
        stderr += String(chunk);
      });
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
      expect(ready).toEqual({ locked: true });
      // The child releases independently while the synchronous reader waits inside SQLite.
      child.send({ release: true });
      const rows = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        expect(() => db.exec("INSERT INTO held VALUES ('unexpected')")).toThrow(/readonly/);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        return db.prepare("SELECT value FROM held").all();
      }, options);
      expect(rows).toEqual([{ value: "committed" }]);
      expect(await closed, stderr).toEqual({ code: 0, signal: null });
      expect(fs.readFileSync(options.path)).toEqual(before);
    } finally {
      await stopChildProcess(child, 5_000);
      await closed;
    }
  });
});

describe.each(["admission", "explicit", "async"] as const)("%s read-only state reads", (mode) => {
  const admittedRead: typeof withExistingOpenClawStateDatabaseReadOnly = (operation, options) =>
    withArtifactPreservingStateReads(() =>
      withExistingOpenClawStateDatabaseReadOnly(operation, options),
    );
  const readState =
    mode === "async"
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync
      : mode === "admission"
        ? admittedRead
        : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  it("reads a consolidated WAL database without creating source sidecars", async () => {
    await withTempDir("openclaw-state-readonly-sidecars-", async (stateDir) => {
      const options = createOptions(stateDir);
      await fsp.mkdir(path.dirname(options.path), { recursive: true });
      const writer = new DatabaseSync(options.path);
      writer.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed');",
      );
      writer.close();
      const before = await fsp.readFile(options.path);
      expect(await fsp.readdir(path.dirname(options.path))).toEqual(["openclaw.sqlite"]);

      expect(
        await readState(({ db }) => {
          expect(isArtifactPreservingStateRead()).toBe(true);
          return db.prepare("SELECT value FROM held").all();
        }, options),
      ).toEqual([{ value: "committed" }]);
      expect(fs.readdirSync(path.dirname(options.path))).toEqual(["openclaw.sqlite"]);
      expect(fs.readFileSync(options.path)).toEqual(before);
    });
  });
  it("reads through the exact dangling Workshop index without changing its source", async () => {
    await withTempDir("openclaw-state-readonly-dangling-workshop-", async (stateDir) => {
      const options = createOptions(stateDir);
      const opened = openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
      const database = new DatabaseSync(opened.path);
      try {
        database.exec(
          "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
        );
        database.enableDefensive?.(false);
        database.exec("PRAGMA writable_schema = ON;");
        database
          .prepare(
            `UPDATE sqlite_schema
              SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                           ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
            WHERE type = 'index'
              AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
          )
          .run();
        const schema = database.prepare("PRAGMA schema_version").get() as {
          schema_version: number;
        };
        database.exec(
          `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema.schema_version + 1};`,
        );
      } finally {
        database.close();
      }
      const before = fs.readFileSync(options.path);

      expect(
        await readState(({ db }) => db.prepare("SELECT role FROM schema_meta").get(), options),
      ).toEqual({ role: "global" });
      expect(fs.readFileSync(options.path)).toEqual(before);
    });
  });
  it.each(["cached", "uncached"])(
    "reads committed rows without joining a %s transaction",
    async (cacheState) => {
      await withTempDir("openclaw-state-readonly-isolated-", async (stateDir) => {
        const options = createOptions(stateDir);
        const opened = openOpenClawStateDatabase(options);
        opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");
        if (cacheState === "uncached") {
          closeOpenClawStateDatabaseForTest();
        }
        const writer = cacheState === "cached" ? opened.db : new DatabaseSync(options.path);
        writer.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
        try {
          const result = await readState(({ db, path: pathname }) => {
            expect(db).not.toBe(writer);
            expect(pathname).toBe(options.path);
            return db.prepare("SELECT value FROM held").all();
          }, options);
          expect(result).toEqual([{ value: "original" }]);
          expect(writer.isTransaction).toBe(true);
          expect(writer.prepare("SELECT value FROM held").all()).toEqual([
            { value: "uncommitted" },
          ]);
        } finally {
          writer.exec("ROLLBACK");
          if (cacheState === "uncached") {
            writer.close();
          }
        }
      });
    },
  );

  it("reuses an idle writable handle without preparing a snapshot", async () => {
    await withTempDir("openclaw-state-readonly-reuse-", async (stateDir) => {
      const options = createOptions(stateDir);
      const opened = openOpenClawStateDatabase(options);
      opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");

      let called = false;
      const result = readState(({ db }) => {
        called = true;
        expect(isArtifactPreservingStateRead()).toBe(true);
        expect(db).toBe(opened.db);
        return db.prepare("SELECT value FROM held").all();
      }, options);
      expect(called).toBe(true);
      expect(isArtifactPreservingStateRead()).toBe(false);
      opened.db.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
      try {
        expect(await result).toEqual([{ value: "original" }]);
        expect(opened.db.isTransaction).toBe(true);
      } finally {
        opened.db.exec("ROLLBACK");
      }
    });
  });
});

it.each(["latch", "quarantine", "callback"] as const)(
  "cleans the async snapshot after %s rejection",
  async (failure) => {
    await withTempDir("openclaw-state-readonly-admission-", async (stateDir) => {
      const options = createOptions(stateDir);
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
      const refused = new Error("synthetic readonly verification failure");
      const prepare = sqliteReadOnly.prepareSqliteReadOnlyLocation;
      let preparedLocation: string | undefined;
      let failurePublished = false;
      vi.spyOn(sqliteReadOnly, "prepareSqliteReadOnlyLocation").mockImplementationOnce(
        async (...args) => {
          const prepared = await prepare(...args);
          preparedLocation = prepared.location;
          if (failure === "latch") {
            failurePublished = recordOpenClawStateDatabaseOpenFailure(options.path, refused);
          } else if (failure === "quarantine") {
            failurePublished = recordOpenClawDatabaseQuarantine({
              env: options.env,
              kind: "state",
              path: options.path,
              reason: "synthetic readonly quarantine",
            });
          }
          return prepared;
        },
      );
      const operation = vi.fn(() => {
        throw refused;
      });
      try {
        const result = withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
          operation,
          options,
        );
        if (failure !== "quarantine") {
          await expect(result).rejects.toBe(refused);
        } else {
          await expect(result).rejects.toThrow("synthetic readonly quarantine");
        }
        if (failure === "callback") {
          expect(operation).toHaveBeenCalledOnce();
        } else {
          expect(failurePublished).toBe(true);
          expect(operation).not.toHaveBeenCalled();
        }
        expect(preparedLocation).toBeDefined();
        expect(fs.existsSync(path.dirname(preparedLocation!))).toBe(false);
        expect(isArtifactPreservingStateRead()).toBe(false);
      } finally {
        clearOpenClawDatabaseQuarantine(options.path, { env: options.env });
      }
    });
  },
);

it("keeps missing and non-missing filesystem failures distinct for async reads", async () => {
  await withTempDir("openclaw-state-readonly-missing-", async (stateDir) => {
    const options = createOptions(stateDir);
    const operation = vi.fn();
    await expect(
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(operation, options),
    ).resolves.toBeUndefined();
    fs.writeFileSync(path.join(stateDir, "file"), "not a directory");
    await expect(
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(operation, {
        ...options,
        path: path.join(stateDir, "file", "state.sqlite"),
      }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(operation).not.toHaveBeenCalled();
  });
});

it("reads under its live mutation owner but refuses an unrelated caller", async () => {
  await withOpenClawTestState({ label: "owned-ledger-read" }, async ({ env }) => {
    const options = { env };
    const initial = openOpenClawStateDatabase(options);
    initial.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original')");
    const pathname = initial.path;
    const owner = await acquireOpenClawStateDatabaseFileExclusion(pathname);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const read = () =>
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
        ({ db }) => db.prepare("SELECT value FROM held").get()?.value,
        options,
      );
    const family = () =>
      Promise.all(
        ["", "-wal", "-shm"].map(async (suffix) => {
          try {
            return await fsp.readFile(pathname + suffix);
          } catch (error) {
            if (hasNodeErrorCode(error, "ENOENT")) {
              return null;
            }
            throw error;
          }
        }),
      );
    let running: Promise<void> | undefined;
    try {
      const before = await family();
      running = owner.mutate(owner.assertCurrent, async () => {
        expect(await read()).toBe("original");
        expect(await family()).toEqual(before);
        entered.resolve();
        await resume.promise;
        owner.assertCurrent();
        const opened = openOpenClawStateDatabase(options);
        opened.db.exec("BEGIN; UPDATE held SET value = 'uncommitted'");
        try {
          await expect(read()).rejects.toThrow(/outside a transaction/);
          expect(opened.db.isTransaction).toBe(true);
          expect(opened.db.prepare("SELECT value FROM held").get()?.value).toBe("uncommitted");
        } finally {
          opened.db.exec("ROLLBACK");
        }
        expect(await read()).toBe("original");
      });
      await Promise.race([entered.promise, running]);
      await expect(read()).rejects.toThrow(/state-handles/);
      expect(await family()).toEqual(before);
    } finally {
      resume.resolve();
      try {
        await running;
      } finally {
        owner.release();
      }
    }
    expect(await read()).toBe("original");
  });
});
