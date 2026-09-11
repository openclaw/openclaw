import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as sqliteLocation from "../infra/sqlite-readonly-location.js";
import {
  runDatabaseVerifyWorker,
  terminateDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import { verifyOpenClawDatabases } from "./openclaw-database-verify.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function importVerifierInUnrelatedFork(): Promise<unknown[]> {
  const fixtureDir = tempDirs.make("openclaw-database-verify-process-");
  const fixturePath = path.join(fixtureDir, "unrelated-child.mjs");
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databaseVerify);
  const verifierUrl = workerUrl.href;
  fs.writeFileSync(
    fixturePath,
    `
      await import(${JSON.stringify(verifierUrl)});
      process.once("message", (message) => {
        process.send?.({ echo: message }, () => process.disconnect?.());
      });
    `,
  );

  const child = fork(fixturePath, [], {
    execArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return await new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("unrelated verifier import did not exit"));
    }, 10_000);
    child.on("message", (message: unknown) => messages.push(message));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(messages);
      } else {
        reject(new Error(`unrelated verifier import exited with ${signal ?? code}`));
      }
    });
    child.send({ type: "unrelated" });
  });
}

describe("database verifier child process entrypoint", () => {
  it("retains native SQLite diagnostics across IPC without changing the source", async () => {
    const fixtureDir = tempDirs.make("openclaw-database-verify-invalid-");
    const databasePath = path.join(fixtureDir, "invalid.sqlite");
    const source = Buffer.from("Synthetic non-SQLite fixture; no user data.\n");
    fs.writeFileSync(databasePath, source);

    await expect(
      runDatabaseVerifyWorker([{ path: databasePath, kind: "state", label: "synthetic database" }]),
    ).resolves.toEqual([
      {
        path: databasePath,
        ok: false,
        error: "Error: file is not a database (code=ERR_SQLITE_ERROR, errcode=26)",
        terminal: false,
      },
    ]);
    expect(fs.readFileSync(databasePath)).toEqual(source);
  });

  it("preserves inherited Node flags for a JavaScript fork", async () => {
    const fixtureDir = tempDirs.make("openclaw-database-verify-flags-");
    const fixturePath = path.join(fixtureDir, "flags.mjs");
    fs.writeFileSync(
      fixturePath,
      `process.once('message', () => {
      process.send([{path:'inherited-node-flag',ok:process.execArgv.includes('--no-warnings')}], () => process.disconnect());
    });`,
    );
    const original = process.execArgv;
    process.execArgv = [...original, "--no-warnings"];
    try {
      await expect(
        runDatabaseVerifyWorker([], { workerUrl: pathToFileURL(fixturePath) }),
      ).resolves.toEqual([{ path: "inherited-node-flag", ok: true }]);
    } finally {
      process.execArgv = original;
    }
  });

  it("does not consume an unrelated fork's IPC messages", async () => {
    await expect(importVerifierInUnrelatedFork()).resolves.toEqual([
      { echo: { type: "unrelated" } },
    ]);
  });
});

describe("database verifier worker lifetime", () => {
  function createWorkerFixture(): URL {
    const fixtureDir = tempDirs.make("openclaw-database-verify-lifetime-");
    const fixturePath = path.join(fixtureDir, "worker.mjs");
    fs.writeFileSync(
      fixturePath,
      `process.once("message", () => {
        process.send([], () => process.disconnect());
      });`,
    );
    return pathToFileURL(fixturePath);
  }

  it("retains a failed IPC worker until exit without losing a concurrent stop waiter", async () => {
    let worker: ChildProcess | undefined;
    let releasedWhileAlive: boolean | undefined;
    const verification = runDatabaseVerifyWorker([], {
      workerUrl: createWorkerFixture(),
      onWorker: (current) => {
        if (current) {
          worker = current;
          current.disconnect();
        } else {
          releasedWhileAlive = worker?.exitCode === null && worker.signalCode === null;
        }
      },
    }).catch((error: unknown) => error);
    if (!worker) {
      throw new Error("verifier did not publish its child");
    }
    const child = worker;
    let stopCompleted = false;
    void terminateDatabaseVerifyWorker(child).then(() => {
      stopCompleted = true;
    });

    await vi.waitFor(() => expect(child.exitCode ?? child.signalCode).not.toBeNull());
    const error = await verification;

    expect(error).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED", message: "Channel closed" });
    expect({ releasedWhileAlive, stopCompleted }).toEqual({
      releasedWhileAlive: false,
      stopCompleted: true,
    });
  });

  it.each(["not delivered", "throws"])(
    "waits for native exit when termination %s",
    async (mode) => {
      let worker: ChildProcess | undefined;
      const verification = runDatabaseVerifyWorker([], {
        workerUrl: createWorkerFixture(),
        onWorker: (current) => {
          worker ??= current;
        },
      });
      if (!worker) {
        throw new Error("verifier did not publish its child");
      }
      const child = worker;
      const kill = vi.spyOn(child, "kill").mockImplementation(() => {
        if (mode === "throws") {
          throw Object.assign(new Error("signal unsupported"), { code: "ENOSYS" });
        }
        return false;
      });
      try {
        const stoppedWhileAlive = await terminateDatabaseVerifyWorker(child).then(
          () => child.exitCode === null && child.signalCode === null,
        );
        await expect(verification).resolves.toEqual([]);
        expect(stoppedWhileAlive).toBe(false);
      } finally {
        kill.mockRestore();
        await verification;
      }
    },
  );

  it("preserves a native spawn failure without waiting for an exit event", async () => {
    const executable = process.execPath;
    let worker: ChildProcess | undefined;
    let closed = false;
    let releasedAfterClose = false;
    let verification: Promise<unknown>;
    try {
      process.execPath = path.join(tempDirs.make("openclaw-verifier-spawn-"), "missing-node");
      verification = runDatabaseVerifyWorker([], {
        workerUrl: createWorkerFixture(),
        onWorker: (current) => {
          if (current) {
            worker = current;
            current.once("close", () => {
              closed = true;
            });
          } else {
            releasedAfterClose = closed;
          }
        },
      });
    } finally {
      process.execPath = executable;
    }

    await expect(verification).rejects.toMatchObject({ code: "ENOENT" });
    expect(worker?.pid).toBeUndefined();
    expect(worker?.exitCode).toBeLessThan(0);
    expect(releasedAfterClose).toBe(true);
  });

  it("preserves the IPC failure when termination reports a second error", async () => {
    let worker: ChildProcess | undefined;
    let restoreKill: (() => void) | undefined;
    const verification = runDatabaseVerifyWorker([], {
      workerUrl: createWorkerFixture(),
      onWorker: (current) => {
        if (current) {
          worker = current;
          const kill = vi.spyOn(current, "kill").mockImplementation(() => {
            current.emit("error", Object.assign(new Error("signal refused"), { code: "EPERM" }));
            return false;
          });
          restoreKill = () => kill.mockRestore();
          current.disconnect();
        }
      },
    });
    try {
      await expect(verification).rejects.toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
    } finally {
      restoreKill?.();
      await vi.waitFor(() => expect(worker?.exitCode ?? worker?.signalCode).not.toBeNull());
    }
  });

  it("keeps stop joined while the native IPC disconnect notification is pending", async () => {
    let worker: ChildProcess | undefined;
    let releaseDisconnect: (() => void) | undefined;
    let restoreEmit: (() => void) | undefined;
    let verificationCompleted = false;
    const verification = runDatabaseVerifyWorker([], {
      workerUrl: createWorkerFixture(),
      onWorker: (current) => {
        if (current) {
          worker = current;
          const emit = current.emit.bind(current);
          const spy = vi.spyOn(current, "emit").mockImplementation((event, ...args) => {
            if (event === "disconnect") {
              releaseDisconnect = () => {
                emit(event, ...args);
              };
              return true;
            }
            return emit(event, ...args);
          });
          restoreEmit = () => spy.mockRestore();
        }
      },
    }).then(() => {
      verificationCompleted = true;
    });
    if (!worker) {
      throw new Error("verifier did not publish its child");
    }
    const child = worker;
    let stopCompleted = false;
    await vi.waitFor(() => expect(child.exitCode ?? child.signalCode).not.toBeNull());
    const termination = terminateDatabaseVerifyWorker(child).then(() => {
      stopCompleted = true;
    });
    try {
      await vi.waitFor(() => expect(releaseDisconnect).toBeTypeOf("function"));
      expect({ stopCompleted, verificationCompleted }).toEqual({
        stopCompleted: false,
        verificationCompleted: false,
      });
    } finally {
      releaseDisconnect?.();
      restoreEmit?.();
      await Promise.all([verification, termination]);
    }
  });
});

describe("database verifier bounded diagnostics", () => {
  const target = { path: "synthetic.sqlite", kind: "state", label: "synthetic database" } as const;

  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      name: "raw I/O error",
      failure: Object.assign(new Error("disk I/O error"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 10,
      }),
      expected: "Error: disk I/O error (code=ERR_SQLITE_ERROR, errcode=10)",
    },
    {
      name: "wrapped I/O error without cause prose or metadata",
      failure: new Error("snapshot failed", {
        cause: Object.assign(new Error("private cause prose"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 10,
          path: "/private/synthetic.sqlite",
          sql: "SELECT private_data",
          extra: { secret: "synthetic secret" },
          stack: "private stack",
        }),
      }),
      expected: "Error: snapshot failed (code=ERR_SQLITE_ERROR, errcode=10)",
    },
    {
      name: "distinct extended codes in traversal order with exact duplicates removed",
      failure: Object.assign(
        new Error("snapshot failed", {
          cause: { code: "EIO", errcode: 778, cause: { code: "ERR_SQLITE_ERROR", errcode: 1034 } },
        }),
        { code: "ERR_SQLITE_ERROR", errcode: 778 },
      ),
      expected:
        "Error: snapshot failed (code=ERR_SQLITE_ERROR, errcode=778, code=EIO, errcode=1034)",
    },
    { name: "non-Error value", failure: "unavailable", expected: "unavailable" },
    {
      name: "plain Error with an unchanged long message",
      failure: new TypeError("original message ".repeat(300)),
      expected: `TypeError: ${"original message ".repeat(300)}`,
    },
    {
      name: "plain object with numeric code",
      failure: { code: 10, errcode: 10, extra: "private metadata" },
      expected: "[object Object] (code=10, errcode=10)",
    },
    {
      name: "aggregate members are excluded",
      failure: new AggregateError(
        [Object.assign(new Error("private aggregate prose"), { code: "EIO", errcode: 10 })],
        "aggregate failure",
      ),
      expected: "AggregateError: aggregate failure",
    },
  ])("preserves $name", async ({ failure, expected }) => {
    vi.spyOn(sqliteLocation, "prepareSqliteReadOnlyLocationInProcess").mockRejectedValueOnce(
      failure,
    );

    await expect(verifyOpenClawDatabases([target])).resolves.toEqual([
      { path: target.path, ok: false, error: expected, terminal: false },
    ]);
  });

  it("bounds cyclic and deep causes without serializing their prose", async () => {
    const cycle = Object.assign(new Error("cyclic failure"), { code: "EIO", errcode: 10 });
    cycle.cause = { code: "EIO", errcode: 10, cause: cycle };
    let deep: unknown = { code: "BEYOND_LIMIT", errcode: 99, message: "private cause prose" };
    for (let index = 7; index >= 0; index -= 1) {
      deep = Object.assign(new Error("deep failure", { cause: deep }), { errcode: index });
    }
    vi.spyOn(sqliteLocation, "prepareSqliteReadOnlyLocationInProcess")
      .mockRejectedValueOnce(cycle)
      .mockRejectedValueOnce(deep);

    await expect(verifyOpenClawDatabases([target, target])).resolves.toEqual([
      {
        path: target.path,
        ok: false,
        error: "Error: cyclic failure (code=EIO, errcode=10)",
        terminal: false,
      },
      {
        path: target.path,
        ok: false,
        error:
          "Error: deep failure (errcode=0, errcode=1, errcode=2, errcode=3, errcode=4, errcode=5, errcode=6, errcode=7)",
        terminal: false,
      },
    ]);
  });

  it.each([
    { code: "X".repeat(65), errcode: 0x8000_0000 },
    { code: "private/path", errcode: -1 },
    { code: "EIO\nprivate prose", errcode: 1.5 },
    { code: "lowercase", errcode: Number.NaN },
    { code: "", errcode: Number.POSITIVE_INFINITY },
    { code: { secret: "private metadata" }, errcode: "10" },
  ])("omits invalid code metadata %#", async (metadata) => {
    const failure = Object.assign(
      new Error("snapshot failed", {
        cause: { code: "EIO", errcode: 10, message: "private cause prose" },
      }),
      metadata,
    );
    vi.spyOn(sqliteLocation, "prepareSqliteReadOnlyLocationInProcess").mockRejectedValueOnce(
      failure,
    );

    await expect(verifyOpenClawDatabases([target])).resolves.toEqual([
      {
        path: target.path,
        ok: false,
        error: "Error: snapshot failed (code=EIO, errcode=10)",
        terminal: false,
      },
    ]);
  });

  it("admits the code length and integer boundaries", async () => {
    const failure = Object.assign(new Error("snapshot failed", { cause: { errcode: 0 } }), {
      code: "X".repeat(64),
      errcode: 0x7fff_ffff,
    });
    vi.spyOn(sqliteLocation, "prepareSqliteReadOnlyLocationInProcess").mockRejectedValueOnce(
      failure,
    );

    await expect(verifyOpenClawDatabases([target])).resolves.toEqual([
      {
        path: target.path,
        ok: false,
        error: `Error: snapshot failed (code=${"X".repeat(64)}, errcode=2147483647, errcode=0)`,
        terminal: false,
      },
    ]);
  });

  it.each([
    { name: "close failure after success", errcode: undefined, terminal: false },
    { name: "original I/O failure before close failure", errcode: 10, terminal: false },
    { name: "original corruption before close failure", errcode: 779, terminal: true },
  ])("preserves $name and classification", async ({ errcode, terminal }) => {
    const database = nodeSqlite.openNodeSqliteDatabase(":memory:");
    const cleanup = vi.fn(() => true);
    vi.spyOn(sqliteLocation, "prepareSqliteReadOnlyLocationInProcess").mockResolvedValueOnce({
      location: ":memory:",
      cleanup,
    });
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockReturnValueOnce(database);
    if (errcode !== undefined) {
      vi.spyOn(database, "prepare").mockImplementationOnce(() => {
        throw Object.assign(new Error("scan failed"), { code: "ERR_SQLITE_ERROR", errcode });
      });
    }
    const close = database.close.bind(database);
    vi.spyOn(database, "close").mockImplementationOnce(() => {
      close();
      throw Object.assign(new Error("close failed"), { code: "EIO", errcode: 10 });
    });
    try {
      await expect(verifyOpenClawDatabases([target])).resolves.toEqual([
        {
          path: target.path,
          ok: false,
          terminal,
          error:
            errcode === undefined
              ? "Error: close failed (code=EIO, errcode=10)"
              : `SqliteIntegrityError: SQLite integrity_check failed for synthetic database: scan failed (code=ERR_SQLITE_ERROR, errcode=${errcode})`,
        },
      ]);
      expect(database.isOpen).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      if (database.isOpen) {
        close();
      }
    }
  });
});
