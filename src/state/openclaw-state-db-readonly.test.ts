import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import * as sqliteReadOnly from "../infra/sqlite-snapshot-source.js";
import { createSqliteWalReclamationResult } from "../infra/sqlite-wal-reclamation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseAsync,
  recordOpenClawStateDatabaseOpenFailure,
} from "./openclaw-state-db-cache.js";
import { iterateOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-read-connection.js";
import {
  isOpenClawStateDatabaseDefinitelyAbsent,
  executeExistingOpenClawStateRead,
  withSynchronousArtifactPreservingStateSnapshot,
  isArtifactPreservingStateRead,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync,
  withExistingOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import * as readWorker from "./openclaw-state-read-worker.js";

function createOptions(stateDir: string) {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    path: path.join(stateDir, "state", "openclaw.sqlite"),
  };
}

// Vitest can enter teardown while a timed-out body is still closing its native owners.
const fixture = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixture.cleanup();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each([undefined, "EACCES"])(
  "keeps authoritative state availability (filesystem failure: %s)",
  async (code) => {
    await withTempDir("openclaw-state-availability-", async (root) => {
      const options = createOptions(root);
      if (code) {
        const probe = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
          throw Object.assign(new Error("synthetic filesystem observation"), { code });
        });
        syncBuiltinESMExports();
        try {
          expect(isOpenClawStateDatabaseDefinitelyAbsent(options.env)).toBe(false);
          expect(probe).toHaveBeenCalledOnce();
        } finally {
          probe.mockRestore();
          syncBuiltinESMExports();
        }
        return;
      }
      expect(isOpenClawStateDatabaseDefinitelyAbsent(options.env)).toBe(true);
      openOpenClawStateDatabase(options);
      const observeMissingPath = (retained: boolean) => {
        const probe = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
          throw Object.assign(new Error("synthetic missing-path observation"), { code: "ENOENT" });
        });
        syncBuiltinESMExports();
        try {
          expect(isOpenClawStateDatabaseDefinitelyAbsent(options.env)).toBe(!retained);
          expect(probe).toHaveBeenCalledTimes(retained ? 0 : 1);
        } finally {
          probe.mockRestore();
          syncBuiltinESMExports();
        }
      };
      observeMissingPath(true);
      closeOpenClawStateDatabaseForTest();
      await withOpenClawStateDatabaseReadSnapshot(async () => observeMissingPath(true), options);
      withArtifactPreservingStateReads(() =>
        withSynchronousArtifactPreservingStateSnapshot(() => {
          withExistingOpenClawStateDatabaseReadOnly(() => observeMissingPath(true), options);
        }),
      );
      observeMissingPath(false);
      expect(fs.existsSync(options.path)).toBe(true);
    });
  },
);

it("keeps fresh synchronous read callbacks from returning asynchronous work", async () => {
  await withTempDir("openclaw-state-sync-read-", async (root) => {
    const options = createOptions(root);
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    let reader: DatabaseSync | undefined;
    expect(() =>
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        reader = db;
        return Promise.resolve(1);
      }, options),
    ).toThrow("SQLite source read must remain synchronous");
    expect(reader?.isOpen).toBe(false);
  });
});

it("preserves read admission denial and recovers the cached reader", async () => {
  await withOpenClawTestState({ label: "state-readonly-authorizer" }, async ({ env }) => {
    const options = { env };
    const opened = openOpenClawStateDatabase(options);
    const operation = vi.fn(() => "unexpected");
    let denied = false;
    opened.db.setAuthorizer((action) => {
      if (action === constants.SQLITE_SELECT && !denied) {
        denied = true;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      expect(() => withExistingOpenClawStateDatabaseReadOnly(operation, options)).toThrow(
        /not authorized/,
      );
    } finally {
      opened.db.setAuthorizer(null);
    }
    expect(denied).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        expect(db).toBe(opened.db);
        return db.prepare("SELECT role FROM schema_meta").get();
      }, options),
    ).toEqual({ role: "global" });
  });
});

it.each(["throw", "failed close"] as const)(
  "ends the native stream snapshot before close on %s",
  async (ending) => {
    await withTempDir("openclaw-state-stream-snapshot-", async (root) => {
      const source = openOpenClawStateDatabase(createOptions(root));
      let reader: DatabaseSync | undefined;
      let finalized = false;
      let transactionAtClose: boolean | undefined;
      let refuseClose = ending === "failed close";
      const failure = new Error("reader close failed");
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted native database receiver.
      const close = DatabaseSync.prototype.close;
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        if (this === reader) {
          transactionAtClose = this.isTransaction;
          if (refuseClose) {
            throw failure;
          }
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
        if (ending === "failed close") {
          await expect(rows.return()).rejects.toBe(failure);
          expect(reader?.isOpen).toBe(true);
          await expect(closeOpenClawStateDatabaseByPathAsync(source.path)).rejects.toThrow(
            "reader close failed",
          );
          expect(reader?.isOpen).toBe(true);
          refuseClose = false;
          await closeOpenClawStateDatabaseByPathAsync(source.path);
        } else {
          const consumerFailure = new Error("stream consumer failed");
          await expect(rows.throw(consumerFailure)).rejects.toBe(consumerFailure);
        }
        expect(finalized).toBe(true);
        expect(transactionAtClose).toBe(false);
        expect(reader?.isOpen).toBe(false);
      } finally {
        refuseClose = false;
        await rows.return();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
);

it("rejects non-filesystem stream sources without interpreting their logical path as a file", async () => {
  await withTempDir("openclaw-state-memory-stream-", async (root) => {
    const db = new DatabaseSync(":memory:");
    const pathname = path.join(root, "logical-state.sqlite");
    const rows = iterateOpenClawStateDatabaseReadOnly(
      {
        db,
        path: pathname,
        walMaintenance: {
          stop: async () => {},
          checkpoint: () => false,
          close: () => false,
          reclaimFreePages: createSqliteWalReclamationResult,
        },
      },
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

it("waits for a transient database lock before a fresh read-only schema inspection", ({ signal }) =>
  fixture.run(async () => {
    signal.throwIfAborted();
    const stateDir = tempDirs.make("openclaw-state-readonly-busy-");
    const options = createOptions(stateDir);
    await fsp.mkdir(path.dirname(options.path), { recursive: true });
    signal.throwIfAborted();
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
        child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      },
    );
    try {
      expectDefined(child.stderr, "SQLite lock child stderr pipe").on("data", (chunk) => {
        stderr += String(chunk);
      });
      const [ready] = await withinTest(
        awaitGateBeforeSettlement(
          once(child, "message", { signal }),
          closed,
          "SQLite lock child exited before acquiring its exclusive lock",
        ),
        signal,
      );
      expect(ready).toEqual({ locked: true });
      // The child releases independently while the synchronous reader waits inside SQLite.
      child.send({ release: true });
      const rows = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        expect(() => db.exec("INSERT INTO held VALUES ('unexpected')")).toThrow(/readonly/);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        return db.prepare("SELECT value FROM held").all();
      }, options);
      expect(rows).toEqual([{ value: "committed" }]);
      expect(await withinTest(closed, signal), stderr).toEqual({ code: 0, signal: null });
      expect(fs.readFileSync(options.path)).toEqual(before);
    } finally {
      await fixture.verifyCleanup(async () => {
        await stopChildProcess(child, 5_000);
        await closed;
      });
    }
  }));

it("reads only active disposable scopes directly and revokes inherited async access", async () => {
  await withTempDir("openclaw-state-disposable-", async (root) => {
    const outer = createOptions(path.join(root, "outer"));
    const inner = createOptions(path.join(root, "inner"));
    const source = createOptions(path.join(root, "source"));
    const paths = [outer, inner, source];
    for (const options of paths) {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      const db = new DatabaseSync(options.path);
      db.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed')",
      );
      db.close();
    }
    const read = (options: ReturnType<typeof createOptions>) =>
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(({ db }) => {
        expect(isArtifactPreservingStateRead()).toBe(true);
        expect(db.prepare("SELECT value FROM held").get()).toEqual({ value: "committed" });
        expect(() => db.exec("INSERT INTO held VALUES ('unexpected')")).toThrow(/readonly/);
        return db.location();
      }, options);
    const sourceBefore = fs.readFileSync(source.path);
    const released = createDeferredCore();
    let descendant: Promise<unknown> | undefined;
    await withDisposableOpenClawStateReads(outer.path, async () => {
      expect(await read(outer)).toBe(outer.path);
      await withDisposableOpenClawStateReads(inner.path, async () => {
        expect(await read(outer)).toBe(outer.path);
        expect(await read(inner)).toBe(inner.path);
        expect(await read(source)).not.toBe(source.path);
        descendant = released.promise.then(() => read(inner));
      });
      expect(await read(inner)).not.toBe(inner.path);
      expect(await read(outer)).toBe(outer.path);
      released.resolve();
      await expect(descendant).rejects.toBeInstanceOf(StateDatabaseReadAdmissionInvalidatedError);
    });
    expect(await read(outer)).not.toBe(outer.path);
    expect(fs.readFileSync(source.path)).toEqual(sourceBefore);
    expect(fs.readdirSync(path.dirname(source.path))).toEqual(["openclaw.sqlite"]);
  });
});
it("requires Doctor for the exact dangling Workshop index without changing its source", async () => {
  await withTempDir("openclaw-state-readonly-dangling-workshop-", async (stateDir) => {
    const options = createOptions(stateDir);
    const opened = openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const database = new DatabaseSync(opened.path);
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT; CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
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

    await expect(
      Promise.resolve().then(() =>
        withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
          ({ db }) => db.prepare("SELECT role FROM schema_meta").get(),
          options,
        ),
      ),
    ).rejects.toThrow(/legacy-workshop-review-index.*openclaw doctor --fix/);
    expect(fs.readFileSync(options.path)).toEqual(before);
  });
});
it("reuses an idle writer but isolates its transaction", async () => {
  await withTempDir("openclaw-state-readonly-isolated-", async (stateDir) => {
    const options = createOptions(stateDir);
    const opened = openOpenClawStateDatabase(options);
    opened.db.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original');");
    let called = false;
    const idle = withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(({ db }) => {
      called = true;
      expect(isArtifactPreservingStateRead()).toBe(true);
      expect(db).toBe(opened.db);
      return db.prepare("SELECT value FROM held").all();
    }, options);
    expect(called).toBe(true);
    expect(isArtifactPreservingStateRead()).toBe(false);
    const writer = opened.db;
    writer.exec("BEGIN; UPDATE held SET value = 'uncommitted';");
    try {
      expect(await idle).toEqual([{ value: "original" }]);
      expect(writer.isTransaction).toBe(true);
      const result = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
        ({ db, path: pathname }) => {
          expect(db).not.toBe(writer);
          expect(pathname).toBe(options.path);
          return db.prepare("SELECT value FROM held").all();
        },
        options,
      );
      expect(result).toEqual([{ value: "original" }]);
      expect(writer.isTransaction).toBe(true);
      expect(writer.prepare("SELECT value FROM held").all()).toEqual([{ value: "uncommitted" }]);
    } finally {
      writer.exec("ROLLBACK");
    }
  });
});

it.each([
  { failure: "quarantine", composite: false },
  { failure: "quarantine", composite: true },
  { failure: "callback", composite: true },
] as const)(
  "cleans the async snapshot after $failure rejection (composite: $composite)",
  async ({ failure, composite }) => {
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
          if (failure === "quarantine") {
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
        const result = composite
          ? withArtifactPreservingStateReads(() =>
              withOpenClawStateDatabaseReadSnapshot(
                async () => withExistingOpenClawStateDatabaseReadOnly(operation, options),
                options,
              ),
            )
          : withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(operation, options);
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

it("shares only one synchronous metadata snapshot and refreshes committed WAL next time", async () => {
  await withTempDir("openclaw-metadata-snapshot-", async (root) => {
    const options = createOptions(root);
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(options.path);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('first');",
    );
    const read = () =>
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT value FROM held").get()?.value,
        options,
      );
    const prepare = vi.spyOn(sqliteReadOnly, "prepareSqliteReadOnlyLocationSync");
    const artifacts = () =>
      ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(options.path + suffix));
    const scope = (operation: () => unknown) =>
      withArtifactPreservingStateReads(() =>
        withSynchronousArtifactPreservingStateSnapshot(operation),
      );
    try {
      const before = artifacts();
      scope(() => {
        expect(read()).toBe("first");
        expect(read()).toBe("first");
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(artifacts()).toEqual(before);
      scope(() => {
        expect(read()).toBe("first");
        writer.exec("UPDATE held SET value='second'");
        expect(read()).toBe("first");
      });
      expect(prepare).toHaveBeenCalledTimes(2);
      scope(() => expect(read()).toBe("second"));
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(() =>
        scope(() => {
          read();
          throw new Error("consumer failure");
        }),
      ).toThrow("consumer failure");
      scope(() => expect(read()).toBe("second"));
      expect(prepare).toHaveBeenCalledTimes(5);
      expect(() => scope(() => Promise.resolve(1))).toThrow("must remain synchronous");
    } finally {
      writer.close();
    }
  });
});

it("keeps the original synchronous snapshot while retained current reads see later commits", async () => {
  await withTempDir("openclaw-retained-inherited-snapshot-", async (root) => {
    const options = createOptions(root);
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(options.path);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
      .run("retained.snapshot.fixture", '"first"', 1);
    const controller = new AbortController();
    const pending: Array<ReturnType<typeof executeExistingOpenClawStateRead>> = [];
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const captured: Array<{
      source: ReturnType<typeof readWorker.captureOpenClawStateReadSource>;
      released: boolean;
    }> = [];
    const captureSource = readWorker.captureOpenClawStateReadSource;
    const capture = vi
      .spyOn(readWorker, "captureOpenClawStateReadSource")
      .mockImplementation(() => {
        const selected = captureSource();
        const read = { source: selected, released: false };
        captured.push(read);
        return {
          ...selected,
          own(service, close) {
            const unregister = selected.own(service, close);
            return () => {
              unregister();
              read.released = true;
            };
          },
        };
      });
    const legacyRead = () =>
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("retained.snapshot.fixture")?.value_json,
        options,
      );
    const finishRead = (current = false) => {
      const index = captured.length;
      pending.push(
        executeExistingOpenClawStateRead(
          options,
          { type: "tui.lastSession.read", stateKey: "retained.snapshot.fixture" },
          { current, signal: controller.signal },
        ),
      );
      const read = captured[index];
      if (!read) {
        throw new Error("Snapshot read source was not captured");
      }
      const deadline = performance.now() + 15_000;
      let microtaskRan = false;
      queueMicrotask(() => {
        microtaskRan = true;
      });
      while (!read.released) {
        read.source.service();
        if (read.released) {
          break;
        }
        if (performance.now() >= deadline) {
          throw new Error("Retained snapshot read did not settle");
        }
        Atomics.wait(wait, 0, 0, 2);
      }
      expect(microtaskRan).toBe(false);
      expect(read.released).toBe(true);
    };
    try {
      withArtifactPreservingStateReads(() =>
        withSynchronousArtifactPreservingStateSnapshot(() => {
          expect(legacyRead()).toBe('"first"');
          writer
            .prepare(
              "UPDATE config_machine_state SET value_json = ?, updated_at_ms = 2 WHERE state_key = ?",
            )
            .run('"second"', "retained.snapshot.fixture");
          const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => {
            throw new Error("Retained read prepared SQLite on the caller thread");
          });
          const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(() => {
            throw new Error("Retained read executed SQLite on the caller thread");
          });
          try {
            finishRead();
            finishRead(true);
            finishRead();
            expect(prepare).not.toHaveBeenCalled();
            expect(exec).not.toHaveBeenCalled();
          } finally {
            prepare.mockRestore();
            exec.mockRestore();
          }
          expect(legacyRead()).toBe('"first"');
        }),
      );
      const replies = await Promise.all(pending);
      expect(
        replies.map((reply) => {
          if (!reply?.ok || reply.type !== "tui.lastSession.read") {
            throw new Error("Retained state read returned the wrong domain reply");
          }
          return reply.row?.value_json;
        }),
      ).toEqual(['"first"', '"second"', '"first"']);
    } finally {
      capture.mockRestore();
      controller.abort(new Error("Snapshot proof finished"));
      await Promise.allSettled(pending);
      await closeOpenClawStateDatabaseAsync();
      await cleanupSnapshotOperations();
      writer.close();
    }
  });
});

it("reads fresh authority without replacing an inherited discovery snapshot", async () => {
  await withTempDir("openclaw-current-snapshot-", async (root) => {
    const options = createOptions(root);
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(options.path);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('first');",
    );
    const read = () =>
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT value FROM held").get()?.value,
        options,
      );
    const current = () =>
      withSynchronousArtifactPreservingStateSnapshot(() => [read(), read()], {
        current: options,
      });
    const artifacts = () =>
      ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(options.path + suffix));
    const inspect = () => {
      expect(read()).toBe("first");
      writer.exec("UPDATE held SET value='revoked'");
      const before = artifacts();
      expect(current()).toEqual(["revoked", "revoked"]);
      expect(artifacts()).toEqual(before);
      expect(read()).toBe("first");
      expect(() =>
        withSynchronousArtifactPreservingStateSnapshot(
          () => {
            expect(read()).toBe("revoked");
            throw new Error("authority consumer failed");
          },
          { current: options },
        ),
      ).toThrow("authority consumer failed");
      expect(read()).toBe("first");
      writer.exec("UPDATE held SET value='later'");
      expect(current()).toEqual(["later", "later"]);
      expect(read()).toBe("first");
      writer.exec("UPDATE held SET value='composite'");
      const prepare = vi.spyOn(sqliteReadOnly, "prepareSqliteReadOnlyLocationSync");
      try {
        expect(
          withSynchronousArtifactPreservingStateSnapshot(() => [read(), ...current()], {
            current: options,
          }),
        ).toEqual(["composite", "composite", "composite"]);
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        prepare.mockRestore();
      }
      expect(read()).toBe("first");
      const foreign = createOptions(path.join(root, "foreign"));
      openOpenClawStateDatabase(foreign).db.exec(
        "CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('committed');",
      );
      runOpenClawStateWriteTransaction(({ db }) => {
        db.exec("UPDATE held SET value='uncommitted'");
        expect(
          withSynchronousArtifactPreservingStateSnapshot(
            () =>
              withExistingOpenClawStateDatabaseReadOnly(
                ({ db: reader }) => reader.prepare("SELECT value FROM held").get()?.value,
                foreign,
              ),
            { current: options },
          ),
        ).toBe("committed");
      }, foreign);
    };
    try {
      await withArtifactPreservingStateReads(() =>
        withOpenClawStateDatabaseReadSnapshot(async () => {
          inspect();
          await Promise.resolve();
          writer.exec("UPDATE held SET value='after-await'");
          expect(current()).toEqual(["after-await", "after-await"]);
          expect(read()).toBe("first");
        }, options),
      );
    } finally {
      writer.close();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it.each(["admission", "cleanup"] as const)(
  "rejects a scoped metadata %s failure without reusing invalid state",
  async (phase) => {
    await withTempDir("openclaw-metadata-failure-", async (root) => {
      const options = createOptions(root);
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
      const failure = new Error("synthetic verification failure");
      const read = () => withExistingOpenClawStateDatabaseReadOnly(() => 1, options);
      const scope = (operation = read) =>
        withArtifactPreservingStateReads(() =>
          withSynchronousArtifactPreservingStateSnapshot(operation),
        );
      if (phase === "admission") {
        scope(() => {
          expect(read()).toBe(1);
          recordOpenClawStateDatabaseOpenFailure(options.path, failure);
          expect(read).toThrow("synthetic verification failure");
          return 1;
        });
      } else {
        const prepare = sqliteReadOnly.prepareSqliteReadOnlyLocationSync;
        let cleanup: (() => boolean) | undefined;
        vi.spyOn(sqliteReadOnly, "prepareSqliteReadOnlyLocationSync").mockImplementationOnce(
          (pathname) => {
            const prepared = prepare(pathname);
            cleanup = prepared.cleanup;
            return {
              ...prepared,
              cleanup: vi
                .fn()
                .mockImplementationOnce(() => false)
                .mockImplementation(prepared.cleanup),
            };
          },
        );
        try {
          expect(() => scope()).toThrow("metadata snapshot cleanup failed");
          expect(scope()).toBe(1);
        } finally {
          cleanup?.();
        }
      }
    });
  },
);
