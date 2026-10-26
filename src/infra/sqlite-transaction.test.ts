import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { getNodeSqliteKysely } from "./kysely-sync.js";
import {
  readEntryIds as readEntries,
  sqliteMaintenanceFixture,
  spySqliteExec,
  thrownBy,
} from "./sqlite-maintenance-fixture.test-support.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "./sqlite-post-commit.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
  withSqliteWriteAdmissionService,
} from "./sqlite-transaction.js";

const resources = sqliteMaintenanceFixture();
const { open: openDatabase, entries: createDatabase } = resources;
const tempDirs = { make: resources.dir };

function fileDatabase(schema: string) {
  const databasePath = resources.file();
  const db = openDatabase(databasePath);
  db.exec(schema);
  return { db, databasePath };
}

function createContendedDatabase() {
  const { db, databasePath } = fileDatabase(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE entries(id TEXT PRIMARY KEY)",
  );
  const writer = openDatabase(databasePath);
  writer.exec("BEGIN IMMEDIATE");
  return { db, writer };
}

function failFullTransaction(db: import("node:sqlite").DatabaseSync) {
  return runSqliteImmediateTransactionSync(db, () =>
    runSqliteImmediateTransactionSync(db, () =>
      db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
    ),
  );
}

function gatedWrite<T>(db: import("node:sqlite").DatabaseSync, write: () => T) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pending = runSqliteImmediateTransaction(
    db,
    async () => write,
    undefined,
    async (run) => {
      entered.resolve();
      await release.promise;
      return run();
    },
  );
  resources.retain(async () => {
    release.resolve();
    await pending.catch(() => undefined);
  });
  return { entered, release, pending };
}

function expectObserverFailure(error: unknown, primary: unknown, observer: Error) {
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) {
    throw new Error("Expected transaction and rollback observer failures to be aggregated");
  }
  expect(error.cause).toBe(primary);
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1]).toBe(observer);
}

it.each([String.raw`C:\OpenClaw\agent.sqlite`, String.raw`\\Server\Share\agent.sqlite`])(
  "services a held write lock across native namespace aliases of %s",
  async (plain) => {
    const filename = resources.file();
    const reader = openDatabase(filename);
    const writer = openDatabase(filename);
    reader.exec("CREATE TABLE proof(value TEXT); PRAGMA busy_timeout=100");
    writer.exec("BEGIN IMMEDIATE");
    // Native SQLite locking stays real; supply the two measured Windows filename spellings.
    vi.spyOn(reader, "location").mockReturnValue(plain);
    vi.spyOn(writer, "location").mockReturnValue(path.win32.toNamespacedPath(plain));
    mockProcessPlatform("win32");
    const release = vi.fn(() => writer.exec("COMMIT"));
    await withSqliteWriteAdmissionService(
      writer,
      () => {},
      () =>
        withSqliteWriteAdmissionService(writer, release, async () => {
          runSqliteImmediateTransactionSync(reader, () => {
            reader.prepare("INSERT INTO proof VALUES (?)").run("committed");
          });
        }),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(reader.prepare("SELECT value FROM proof").all()).toEqual([{ value: "committed" }]);
    // Removing the last service must remove it for both spellings.
    writer.exec("BEGIN IMMEDIATE");
    reader.exec("PRAGMA busy_timeout=20");
    const started = Date.now();
    expect(() => runSqliteImmediateTransactionSync(reader, () => undefined)).toThrow(
      "database is locked",
    );
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(15);
    expect(elapsedMs).toBeLessThan(200);
    expect(release).toHaveBeenCalledOnce();
  },
);

describe("runSqliteDeferredTransactionSync", () => {
  it("keeps multiple reads on one snapshot while another connection commits", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-read-snapshot-");
    const databasePath = path.join(tempDir, "snapshot.sqlite");
    const reader = openDatabase(databasePath);
    const writer = openDatabase(databasePath);
    reader.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('first');",
    );
    writer.exec("PRAGMA busy_timeout = 1000;");

    const counts = runSqliteDeferredTransactionSync(reader, () => {
      const before = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      writer.prepare("INSERT INTO entries(id) VALUES (?)").run("second");
      const after = reader.prepare("SELECT COUNT(*) AS count FROM entries").get() as {
        count: number;
      };
      return [before.count, after.count];
    });

    expect(counts).toEqual([1, 1]);
    expect(writer.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 2 });
  });
});

describe("runSqliteReadSnapshotSync", () => {
  it("shares one snapshot across nested reads and sees the next commit afterward", () => {
    const databasePath = resources.file();
    const reader = openDatabase(databasePath);
    const writer = openDatabase(databasePath);
    reader.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY); INSERT INTO entries VALUES ('first');",
    );
    const rows = runSqliteReadSnapshotSync(reader, () => {
      const before = readEntries(reader);
      writer.prepare("INSERT INTO entries VALUES (?)").run("second");
      const nested = runSqliteReadSnapshotSync(reader, () => readEntries(reader));
      return { before, nested };
    });

    expect(rows).toEqual({ before: ["first"], nested: ["first"] });
    expect(reader.isTransaction).toBe(false);
    expect(readEntries(reader)).toEqual(["first", "second"]);
  });

  it.each([false, true])("rejects asynchronous reads with an existing snapshot: %s", (nested) => {
    const db = createDatabase();
    const read = () => runSqliteReadSnapshotSync(db, () => Promise.resolve(readEntries(db)));
    if (nested) {
      runSqliteDeferredTransactionSync(db, () => {
        expect(read).toThrow("Promise returns are not supported");
        expect(db.isTransaction).toBe(true);
      });
    } else {
      expect(read).toThrow("Promise returns are not supported");
    }
    expect(db.isTransaction).toBe(false);
  });
});

describe("runSqliteImmediateTransactionSync", () => {
  it("preserves SQLITE_FULL and prevents caught nested failures from committing later writes", async () => {
    const { db, databasePath } = fileDatabase(
      "CREATE TABLE entries (id TEXT PRIMARY KEY, value BLOB); PRAGMA max_page_count=3",
    );
    let primaryError: unknown;
    let nestedError: unknown;
    let stagedValue = "before";
    const published: string[] = [];
    const stateEvents: string[] = [];
    const stage = (value: string) => {
      const previous = stagedValue;
      stageSqliteTransactionState(db, {
        stage: () => {
          stagedValue = value;
        },
        rollback: () => {
          stagedValue = previous;
          stateEvents.push(`rollback:${value}`);
        },
        commit: () => {
          stateEvents.push(`commit:${value}`);
        },
      });
      deferSqlitePostCommitPublication(db, () => published.push(value));
    };
    const outerError = thrownBy(() =>
      runSqliteImmediateTransactionSync(db, () => {
        db.prepare("INSERT INTO entries VALUES ('outer', 'kept only on commit')").run();
        stage("outer");
        nestedError = thrownBy(() =>
          runSqliteImmediateTransactionSync(db, () => {
            stage("inner");
            primaryError = thrownBy(() =>
              db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
            );
            throw primaryError;
          }),
        );
        // Even a caller that catches the failure cannot publish or autocommit
        // a continuation after SQLite has aborted the enclosing transaction.
        expect(stagedValue).toBe("before");
        expect(() =>
          db.prepare("INSERT INTO entries VALUES ('continuation', 'must not persist')").run(),
        ).toThrow();
      }),
    );
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(nestedError).toBe(primaryError);
    expect(outerError).toBe(primaryError);
    expect(db.isOpen).toBe(false);
    expect(stagedValue).toBe("before");
    expect(stateEvents).toEqual(["rollback:inner", "rollback:outer"]);
    expect(published).toEqual([]);
    expect(thrownBy(() => runSqliteImmediateTransactionSync(db, () => undefined))).toBe(
      primaryError,
    );
    const read = vi.fn(() => undefined);
    expect(thrownBy(() => runSqliteReadSnapshotSync(db, read))).toBe(primaryError);
    expect(read).not.toHaveBeenCalled();
    const prepare = vi.fn(async () => () => undefined);
    await expect(runSqliteImmediateTransaction(db, prepare)).rejects.toBe(primaryError);
    expect(prepare).not.toHaveBeenCalled();

    const reopened = openDatabase(databasePath);
    expect(readEntries(reopened)).toEqual([]);
    runSqliteImmediateTransactionSync(reopened, () => {
      reopened.prepare("INSERT INTO entries VALUES ('recovered', 'ok')").run();
    });
    expect(readEntries(reopened)).toEqual(["recovered"]);
    expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it.each(["automatic", "ROLLBACK", "ROLLBACK TO SAVEPOINT"] as const)(
    "settles a failed %s rollback even when its observer throws",
    (failedStep) => {
      const db = createDatabase();
      const automatic = failedStep === "automatic";
      const nested = failedStep === "ROLLBACK TO SAVEPOINT";
      if (automatic) {
        db.exec("PRAGMA max_page_count=3");
      }
      let primaryError: unknown = new Error("operation failed");
      const observerError = new Error("rollback observer failed");
      const events: string[] = [];
      const rollbackErrors: unknown[] = [];
      const facadeBeforeClose = automatic ? undefined : getNodeSqliteKysely(db);
      let facadeAtClose: unknown;
      if (!automatic) {
        const close = db.close.bind(db);
        vi.spyOn(db, "close").mockImplementation(() => {
          events.push("close");
          facadeAtClose = getNodeSqliteKysely(db);
          close();
        });
        spySqliteExec(db, (sql) => {
          if (sql.startsWith(failedStep)) {
            throw new Error("injected native cleanup failure");
          }
        });
      }
      const stage = (label: string, fails: boolean) => {
        stageSqliteTransactionState(db, {
          stage: () => {
            events.push(`stage:${label}`);
          },
          rollback: (error) => {
            rollbackErrors.push(error);
            events.push(`rollback:${label}`);
            if (fails) {
              throw observerError;
            }
          },
          commit: () => {
            events.push(`commit:${label}`);
          },
        });
        deferSqlitePostCommitPublication(db, () => events.push(`publish:${label}`));
      };
      const fail = () => {
        if (automatic) {
          primaryError = thrownBy(() =>
            db.prepare("INSERT INTO entries VALUES ('full', zeroblob(65536))").run(),
          );
        }
        throw primaryError;
      };
      let nestedError: unknown;
      const reportedError = thrownBy(() =>
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare("INSERT INTO entries VALUES ('outer', 'uncommitted')").run();
          stage("outer", !nested);
          if (!nested) {
            fail();
          }
          nestedError = thrownBy(() =>
            runSqliteImmediateTransactionSync(db, () => {
              db.prepare("INSERT INTO entries VALUES ('inner', 'uncommitted')").run();
              stage("inner", true);
              fail();
            }),
          );
        }),
      );
      expectObserverFailure(reportedError, primaryError, observerError);
      for (const error of rollbackErrors) {
        expect(error).toBe(primaryError);
      }
      expect(events).toEqual([
        "stage:outer",
        ...(nested ? ["stage:inner", "rollback:inner"] : []),
        "rollback:outer",
        ...(automatic ? [] : ["close"]),
      ]);
      if (automatic) {
        expect(primaryError).toMatchObject({ errcode: 13 });
        expect(db.isOpen).toBe(true);
        expect(db.isTransaction).toBe(false);
        expect(readEntries(db)).toEqual([]);
        runSqliteImmediateTransactionSync(db, () =>
          db.prepare("INSERT INTO entries VALUES ('recovered', 'ok')").run(),
        );
        expect(readEntries(db)).toEqual(["recovered"]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } else {
        expect(db.isOpen).toBe(false);
        expect(facadeAtClose).toBeDefined();
        expect(facadeAtClose).not.toBe(facadeBeforeClose);
        if (nested) {
          expect(nestedError).toBe(reportedError);
        }
        const reuse = vi.fn();
        expect(thrownBy(() => runSqliteImmediateTransactionSync(db, reuse))).toBe(reportedError);
        expect(reuse).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["throw", "promise"] as const)(
    "fences the connection when the commit owner fails after COMMIT (%s)",
    (failure) => {
      const { db, databasePath } = fileDatabase(
        "CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT)",
      );
      const ownerError = new Error("commit owner failed after commit");
      const withCommit =
        failure === "throw"
          ? (commit: () => void) => {
              commit();
              throw ownerError;
            }
          : async (commit: () => void) => {
              commit();
            };
      const publish = vi.fn();
      const operation = vi.fn(() => {
        db.prepare("INSERT INTO entries VALUES ('committed', 'durable')").run();
        deferSqlitePostCommitPublication(db, publish);
      });

      expect(() =>
        // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous commit-owner contract.
        runSqliteImmediateTransactionSync(db, operation, { withCommit }),
      ).toThrow(failure === "throw" ? ownerError : "must be synchronous");
      expect(operation).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
      expect(() => runSqliteImmediateTransactionSync(db, operation)).toThrow(
        failure === "throw" ? ownerError : "must be synchronous",
      );
      expect(operation).toHaveBeenCalledOnce();
      const reopened = openDatabase(databasePath);
      expect(readEntries(reopened)).toEqual(["committed"]);
    },
  );

  it("rejects Promise-returning operations and rolls back their synchronous writes", () => {
    const db = createDatabase();

    expect(() =>
      runSqliteImmediateTransactionSync(db, async () => {
        db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("async", "rolled back");
        return "done";
      }),
    ).toThrow("must be synchronous");
    expect(readEntries(db)).toEqual([]);

    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES (?, ?)").run("after", "works");
    });
    expect(readEntries(db)).toEqual(["after"]);
  });

  it.each([false, true])(
    "forwards an admission service refusal (lock error: %s)",
    async (lockError) => {
      const { db, writer } = createContendedDatabase();
      const failure = lockError
        ? Object.assign(new Error("service lock failure"), { code: "SQLITE_BUSY", errcode: 5 })
        : new Error("service authority refused");
      const write = vi.fn(() => db.prepare("INSERT INTO entries VALUES ('unexpected')").run());
      await expect(
        withSqliteWriteAdmissionService(
          db,
          () => {
            throw failure;
          },
          async () => {
            runSqliteImmediateTransactionSync(db, write, { logger: { warn: vi.fn() } });
          },
        ),
      ).rejects.toBe(failure);
      expect(write).not.toHaveBeenCalled();
      expect(writer.isTransaction).toBe(true);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
      writer.exec("ROLLBACK");
      runSqliteImmediateTransactionSync(db, () =>
        db.prepare("INSERT INTO entries VALUES ('after-refusal')").run(),
      );
      expect(readEntries(db)).toEqual(["after-refusal"]);
    },
  );
});

describe("runSqliteImmediateTransaction", () => {
  it("preserves a failed nested rollback when preparation declines the write", async () => {
    const db = createDatabase();
    db.exec("PRAGMA max_page_count=3");
    let primaryError: unknown;
    const prepare = vi.fn(async () => {
      await Promise.resolve();
      primaryError = thrownBy(() => failFullTransaction(db));
      return undefined;
    });
    const reportedError = await runSqliteImmediateTransaction(db, prepare).catch(
      (error: unknown) => error,
    );
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(reportedError).toBe(primaryError);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(db.isOpen).toBe(false);
  });

  it.each([false, true])(
    "preserves a failed rollback during admission yield (deadline expired: %s)",
    async (expireDeadline) => {
      const dir = tempDirs.make("openclaw-sqlite-admission-abort-");
      const db = openDatabase(path.join(dir, "index.sqlite"));
      const writer = openDatabase(path.join(dir, "index.sqlite"));
      const busyTimeoutMs = expireDeadline ? 100 : 1000;
      db.exec(`CREATE TABLE entries(id INTEGER PRIMARY KEY, value BLOB);
        PRAGMA max_page_count=2; PRAGMA busy_timeout=${busyTimeoutMs}`);
      writer.exec("BEGIN IMMEDIATE");
      let primaryError: unknown;
      let faultScheduled = false;
      let faultDone = Promise.resolve();
      const write = vi.fn(() =>
        db.prepare("INSERT INTO entries(value) VALUES ('unexpected')").run(),
      );
      const prepare = vi.fn(async () => {
        db.prepare("SELECT COUNT(*) FROM entries").get();
        if (!faultScheduled) {
          faultScheduled = true;
          faultDone = new Promise<void>((resolve) => {
            setImmediate(() => {
              try {
                writer.exec("ROLLBACK");
                runSqliteImmediateTransactionSync(db, () =>
                  runSqliteImmediateTransactionSync(db, () =>
                    db.prepare("INSERT INTO entries(value) VALUES (zeroblob(65536))").run(),
                  ),
                );
              } catch (error) {
                primaryError = error;
              } finally {
                // Keep the admission timer from resuming until its real deadline expires.
                if (expireDeadline) {
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, busyTimeoutMs + 20);
                }
                resolve();
              }
            });
          });
        }
        return write;
      });
      const reportedError = await runSqliteImmediateTransaction(db, prepare).catch(
        (error: unknown) => error,
      );
      await faultDone;
      expect(primaryError).toMatchObject({ errcode: 13 });
      expect(reportedError).toBe(primaryError);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isOpen).toBe(false);
      expect(writer.prepare("SELECT id FROM entries").all()).toEqual([]);
    },
  );

  it("preserves a failed rollback caught while waiting for owner admission", async () => {
    const db = createDatabase();
    db.exec("PRAGMA max_page_count=3");
    const write = vi.fn(() => "unexpected");
    const { entered, release, pending } = gatedWrite(db, write);
    await entered.promise;
    const primaryError = thrownBy(() => failFullTransaction(db));
    expect(primaryError).toMatchObject({ errcode: 13 });
    expect(db.isOpen).toBe(false);
    release.resolve();
    await expect(pending).rejects.toBe(primaryError);
    expect(write).not.toHaveBeenCalled();
  });

  it("waits for the owner's admission before beginning a prepared write", async () => {
    const db = createDatabase();
    const { entered, release, pending } = gatedWrite(db, () => {
      db.prepare("INSERT INTO entries(id, value) VALUES ('admitted', 'value')").run();
      return "committed";
    });
    const first = await Promise.race([
      entered.promise.then(() => "admission"),
      pending.then(() => "committed"),
    ]);
    expect(first).toBe("admission");
    expect(db.isTransaction).toBe(false);
    expect(readEntries(db)).toEqual([]);
    release.resolve();
    await expect(pending).resolves.toBe("committed");
    expect(readEntries(db)).toEqual(["admitted"]);
  });

  it.each(["existing", "preparation", "admission", "retired"])(
    "refuses a write when the owner becomes unavailable during %s",
    async (phase) => {
      const db = createDatabase();
      const write = vi.fn(() => "unexpected");
      const prepare = vi.fn(async () => {
        if (phase === "preparation") {
          db.exec("BEGIN");
        }
        return write;
      });
      if (phase === "existing") {
        db.exec("BEGIN");
      }
      await expect(
        runSqliteImmediateTransaction(db, prepare, undefined, async (admittedWrite) => {
          if (phase === "retired") {
            throw new Error("owner retired");
          }
          if (phase === "admission") {
            db.exec("BEGIN");
          }
          return admittedWrite();
        }),
      ).rejects.toThrow(phase === "retired" ? "owner retired" : /transaction/);
      expect(prepare).toHaveBeenCalledTimes(phase === "existing" ? 0 : 1);
      expect(write).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(phase !== "retired");
    },
  );

  it("repeats preparation and can decline a write while another writer remains active", async () => {
    const { db, writer } = createContendedDatabase();
    let eligible = true;
    let preparations = 0;
    const write = vi.fn(() => db.prepare("INSERT INTO entries VALUES ('unexpected')").run());
    const pending = runSqliteImmediateTransaction(db, async () => {
      preparations += 1;
      expect(db.isTransaction).toBe(false);
      return eligible ? write : undefined;
    });
    void pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(preparations).toBeGreaterThan(1));
      eligible = false;
      await expect(pending).resolves.toBeUndefined();
      expect(writer.isTransaction).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(db.prepare("SELECT id FROM entries").all()).toEqual([]);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    } finally {
      writer.exec("ROLLBACK");
      await pending.catch(() => undefined);
    }
  });

  it("prepares without holding a transaction and never replays an admitted write", async () => {
    const db = createDatabase();
    db.exec("PRAGMA busy_timeout = 50");
    const lockError = Object.assign(new Error("database is locked"), { errcode: 5 });
    let calls = 0;
    await expect(
      runSqliteImmediateTransaction(db, async () => {
        await Promise.resolve();
        expect(db.isTransaction).toBe(false);
        return () => {
          calls += 1;
          expect(db.isTransaction).toBe(true);
          expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
          db.prepare("INSERT INTO entries(id, value) VALUES ('aborted', 'value')").run();
          throw lockError;
        };
      }),
    ).rejects.toBe(lockError);
    expect(calls).toBe(1);
    expect(readEntries(db)).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});
