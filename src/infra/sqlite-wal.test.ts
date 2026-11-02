import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { probeTreeClone } from "@openclaw/fs-safe/copy";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  sqliteMaintenanceFixture,
  sqliteSchedulerClock,
  spySqliteExec,
  thrownBy,
} from "./sqlite-maintenance-fixture.test-support.js";
import { sqliteMaintenanceEntrypoints } from "./sqlite-maintenance-runtime.test-support.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { detectSqliteWalSplitBrain } from "./sqlite-wal-split-brain.js";
import { registerSqliteWalWorkerMaintenance } from "./sqlite-wal-write-admission.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  configureSqliteWalMaintenance,
} from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();
const tempDirs = { make: resources.dir };
const directoryFs: { readdir(pathname: fs.PathLike): Promise<string[]> } = fs.promises;

vi.mock("@openclaw/fs-safe/copy", { spy: true });

function configure(
  db: DatabaseSync,
  options: Parameters<typeof configureSqliteWalMaintenance>[1] = {},
) {
  return configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0, ...options });
}

function createMockDb(checkpointResult = { busy: 0, log: 0, checkpointed: 0 }): DatabaseSync {
  return {
    close: vi.fn(),
    exec: vi.fn(),
    isOpen: true,
    location: () => "untracked.sqlite",
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() =>
        sql.includes("wal_checkpoint")
          ? checkpointResult
          : sql === "PRAGMA freelist_count"
            ? { freelist_count: 1024 }
            : { journal_mode: sql === "PRAGMA journal_mode = WAL;" ? "wal" : "delete" },
      ),
    })),
  } as unknown as DatabaseSync;
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

function mockMountCommand(output: string): void {
  vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
  vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw new Error("no proc mountinfo");
  });
  vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.from(output));
}

describe("sqlite WAL maintenance", () => {
  it("uses rollback journaling for databases on NFS-backed volumes", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "missing", "openclaw.sqlite"),
    });

    expect(statfs).toHaveBeenCalledWith(fs.realpathSync(tempDir));
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
    expect(maintenance.checkpoint()).toBe(true);
    expect(maintenance.close()).toBe(true);
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it.each([
    ["SMB", 0x517b],
    ["CIFS", 0xff534d42],
    ["SMB2", 0xfe534d42],
    ["9p (V9FS)", 0x01021997],
  ])("uses rollback journaling for databases on Linux %s volumes", (_label, fsType) => {
    const tempDir = tempDirs.make("openclaw-sqlite-network-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(fsType));

    configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      databasePath: path.join(tempDir, "openclaw.sqlite"),
    });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
  });

  it.each([
    String.raw`\\server\share\openclaw.sqlite`,
    String.raw`\\?\UNC\server\share\openclaw.sqlite`,
  ])("uses rollback journaling for databases on Windows UNC paths: %s", (databasePath) => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    configure(db, { databasePath });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it.each([
    [
      String.raw`Z:\state\openclaw.sqlite`,
      String.raw`\\server\share\state\openclaw.sqlite`,
      "DELETE",
    ],
    [String.raw`\\?\C:\state\openclaw.sqlite`, String.raw`\\?\C:\state\openclaw.sqlite`, "WAL"],
    [String.raw`Z:\restricted\openclaw.sqlite`, undefined, "DELETE"],
  ] as const)(
    "selects Windows journaling for %s resolved to %s",
    (databasePath, resolved, journal) => {
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
        if (resolved === undefined) {
          throw new Error("access denied");
        }
        return resolved;
      });
      configure(db, { databasePath });
      expect(realpath).toHaveBeenCalledWith(databasePath);
      expect(db["prepare"]).toHaveBeenCalledWith(`PRAGMA journal_mode = ${journal};`);
      if (journal === "DELETE") {
        expect(db["exec"]).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses network-backed databases when SQLite keeps WAL active", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-nfs-");
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockReturnValue({
      get: vi.fn(() => ({ journal_mode: "wal" })),
    } as unknown as ReturnType<DatabaseSync["prepare"]>);
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0x6969));

    expect(() =>
      configure(db, {
        databaseLabel: "test-db",
        databasePath: path.join(tempDir, "openclaw.sqlite"),
      }),
    ).toThrow(/test-db .*journal_mode=wal/);
  });

  it("reclaims an inflated WAL on the first commit after a completed checkpoint", () => {
    const { writer: db, databasePath: dbPath } = resources.wal({
      autoCheckpointPages: 0,
      databaseLabel: "wal-size-default",
    });
    const walPath = `${dbPath}-wal`;
    db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT INTO payload (value) VALUES (?)").run("before-checkpoint");

    const checkpoint = expectDefined(
      db.prepare("PRAGMA wal_checkpoint(PASSIVE);").get(),
      "checkpoint result",
    );
    expect(checkpoint).toMatchObject({ busy: 0, checkpointed: checkpoint.log });

    const sizeLimit = Number(db.prepare("PRAGMA journal_size_limit;").get()?.journal_size_limit);
    expect(sizeLimit).toBe(64 * 1024 * 1024);
    // A sparse extension models a retained high-water WAL without writing a 65 MiB fixture.
    fs.truncateSync(walPath, sizeLimit + 1024 * 1024);

    db.prepare("INSERT INTO payload (value) VALUES (?)").run("after-checkpoint");

    expect(fs.statSync(walPath).size).toBe(sizeLimit);
  });

  it("rejects a memory journal for a file-backed database", () => {
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockImplementation(
      (sql) =>
        ({
          all: vi.fn(() =>
            sql === "PRAGMA database_list;"
              ? [{ name: "main", file: "/tmp/file-backed.sqlite" }]
              : [],
          ),
          get: vi.fn(() => ({ journal_mode: "memory" })),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    expect(() => configure(db, { databaseLabel: "file-backed-test-db" })).toThrow(
      "file-backed-test-db could not enable WAL; SQLite kept journal_mode=memory",
    );
  });

  it("uses rollback journaling for cross-VM mounts", () => {
    const fsType = "fuse.virtiofs";
    const tempDir = tempDirs.make("openclaw-sqlite-virtiofs-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `42 12 0:41 / ${tempDir} rw,relatime - ${fsType} host0 rw\n`,
    );

    configure(db, { databasePath: path.join(tempDir, "openclaw.sqlite") });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = DELETE;");
    expect(db["exec"]).not.toHaveBeenCalled();
  });

  it.each(["canonical", "raw"])(
    "refuses symlinked SSHFS paths matched by the %s mount prefix",
    (prefix) => {
      if (process.platform === "win32") {
        return;
      }
      const tempDir = tempDirs.make("openclaw-sqlite-sshfs-link-");
      const mountDir = path.join(tempDir, "mount");
      const linkedDir = path.join(tempDir, "linked");
      fs.mkdirSync(mountDir);
      fs.symlinkSync(mountDir, linkedDir);
      const canonicalMountDir = fs.realpathSync(mountDir);
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        `42 12 0:41 / ${prefix === "canonical" ? canonicalMountDir : linkedDir} rw,relatime - fuse.sshfs user@host:/share rw\n`,
      );

      expect(() =>
        configure(createMockDb(), { databasePath: path.join(linkedDir, "openclaw.sqlite") }),
      ).toThrow(/SSHFS.*refusing to open/);
    },
  );

  it("preserves WAL policy when mount classification fails without timing out", () => {
    const tempDir = tempDirs.make("openclaw-sqlite-mount-error-");
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw Object.assign(new Error("spawnSync mount ENOENT"), { code: "ENOENT" });
    });

    configure(db, { databasePath: path.join(tempDir, "openclaw.sqlite") });

    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA journal_mode = WAL;");
  });

  it.each([
    ["darwin", "smbfs", "//server/share", "DELETE"],
    ["darwin", "macfuse", "sshfs#user@host:/share", "refuse"],
    ["darwin", "macfuse", "host:/share", "refuse"],
    ["darwin", "osxfuse", "sshfs@osxfuse0", "refuse"],
    ["darwin", "macfuse", "remote-volume", "WAL"],
    ["linux", "nfs4", "server:/share", "DELETE"],
  ] as const)(
    "classifies %s mount output for %s source %s",
    (platform, fsType, source, journal) => {
      const tempDir = tempDirs.make("openclaw-sqlite-mount-");
      const db = createMockDb();
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      mockMountCommand(
        platform === "linux"
          ? `${source} on ${tempDir} type ${fsType} (rw,relatime)\n`
          : `${source} on ${tempDir} (${fsType}, nodev, nosuid)\n`,
      );
      const run = () => configure(db, { databasePath: path.join(tempDir, "openclaw.sqlite") });
      if (journal === "refuse") {
        expect(run).toThrow(/refusing to open/);
        expect(db["exec"]).not.toHaveBeenCalled();
      } else {
        run();
        expect(db["prepare"]).toHaveBeenCalledWith(`PRAGMA journal_mode = ${journal};`);
      }
    },
  );

  it("runs periodic maintenance outside request contexts and TRUNCATE on close", async () => {
    vi.useFakeTimers();
    const requestScope = new AsyncLocalStorage<object>();
    const sessionScope = new AsyncLocalStorage<object>();
    const request = {};
    const session = {};
    const timerContexts: Array<[object | undefined, object | undefined]> = [];
    const periodic = createDeferredCore<[object | undefined, object | undefined]>();
    const setTimeoutNative = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      timerContexts.push([requestScope.getStore(), sessionScope.getStore()]);
      return setTimeoutNative(callback, delay, ...args);
    });
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["exec"]).mockImplementation((sql) => {
      if (sql === "PRAGMA incremental_vacuum(8);") {
        periodic.resolve([requestScope.getStore(), sessionScope.getStore()]);
      }
    });
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      await requestScope.run(request, () =>
        sessionScope.run(session, async () => {
          maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 5 });
          expect(requestScope.getStore()).toBe(request);
          expect(sessionScope.getStore()).toBe(session);
          // The native resource must be detached at allocation, not only when its callback runs.
          expect(timerContexts).toEqual([[undefined, undefined]]);
          await vi.advanceTimersByTimeAsync(5);
          expect(await periodic.promise).toEqual([undefined, undefined]);
          expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
          expect(db["exec"]).toHaveBeenCalledWith("PRAGMA incremental_vacuum(8);");
          await maintenance.stop();
          expect(maintenance.close()).toBe(true);
          expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(TRUNCATE);");
          expect(requestScope.getStore()).toBe(request);
          expect(sessionScope.getStore()).toBe(session);
          const statementsAfterClose = vi.mocked(db).exec.mock.calls.length;

          await vi.advanceTimersByTimeAsync(10);
          expect(db["exec"]).toHaveBeenCalledTimes(statementsAfterClose);
        }),
      );
    } finally {
      maintenance?.close();
      requestScope.disable();
      sessionScope.disable();
    }
  });

  it.each([false, true])(
    "joins a delayed sidecar scan without blocking host work (retire: %s)",
    async (retire) => {
      const clock = sqliteSchedulerClock();
      const databasePath = resources.file();
      const db = resources.open(databasePath);
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      const maintenance = resources.maintain(db, { databasePath, checkpointIntervalMs: 100 });
      const execute = vi.fn(async () => undefined);
      registerSqliteWalWorkerMaintenance(db, execute);
      const scanned = createDeferredCore<string[]>();
      const readdir = vi.spyOn(directoryFs, "readdir").mockImplementation(() => scanned.promise);
      const syncRead = vi.spyOn(fs, "readdirSync").mockReturnValue([]);
      let closing: Promise<void> | undefined;
      const running = clock.advanceBy(100);
      try {
        expect(syncRead).not.toHaveBeenCalled();
        expect(readdir).toHaveBeenCalledOnce();
        await Promise.resolve();
        expect(execute).not.toHaveBeenCalled();
        if (retire) {
          closing = maintenance.stop();
        }
      } finally {
        scanned.resolve([]);
        await running;
        await closing;
      }
      expect(execute).toHaveBeenCalledTimes(retire ? 0 : 1);
      if (!retire) {
        expect(execute).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 512 }));
      }
    },
  );

  it.each([false, true])(
    "holds checkpoint ticks and explicit maintenance behind sidecar inspection (tracked: %s)",
    async (tracked) => {
      const clock = sqliteSchedulerClock();
      const databasePath = resources.file();
      const db = resources.open(databasePath, {}, tracked);
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      const maintenance = resources.maintain(db, { databasePath, checkpointIntervalMs: 60_000 });
      db.exec("CREATE TABLE entries (value TEXT);");
      await clock.advanceBy(50_000);
      db.prepare("INSERT INTO entries VALUES ('pending');").run();
      const prepare = vi.spyOn(db, "prepare");
      const close = vi.spyOn(db, "close");
      const disposeDependent = vi.fn();
      registerNodeSqliteDisposeCallback(db, disposeDependent);
      const inspecting = createDeferredCore();
      const inspected = createDeferredCore<fs.BigIntStats>();
      const sidecarPath = `${databasePath}-wal`;
      vi.spyOn(directoryFs, "readdir").mockResolvedValue(["42"]);
      vi.spyOn(fs.promises, "readlink").mockResolvedValue(sidecarPath);
      vi.spyOn(fs, "fstat").mockImplementation((_fd, _options, callback) =>
        callback(null, { dev: 10n, ino: 20n, nlink: 1n } as fs.BigIntStats),
      );
      vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
        inspecting.resolve();
        return inspected.promise;
      });
      vi.spyOn(fs, "writeSync").mockReturnValue(1);
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      vi.spyOn(process, "abort").mockImplementation(() => {
        throw new Error("process abort intercepted");
      });
      const running = clock.advanceBy(10_000);
      try {
        await inspecting.promise;
        expect(prepare).not.toHaveBeenCalled();
        expect(maintenance.checkpoint()).toBe(false);
        expect(() => maintenance.reclaimFreePages()).toThrow("owner is unavailable");
        expect(maintenance.close()).toBe(false);
        expect(() => db.close()).toThrow("SQLite WAL inspection is pending");
        expect(db.isOpen).toBe(true);
        expect(disposeDependent).not.toHaveBeenCalled();
        close.mockClear();
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        inspected.resolve({ dev: 10n, ino: 21n } as fs.BigIntStats);
        await running;
      }
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
      expect(prepare).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "unlinked", sidecar: "wal", stopping: false },
    { kind: "replaced", sidecar: "shm", stopping: false },
    { kind: "replaced", sidecar: "shm", stopping: true },
  ] as const)(
    "hard-stops without closing a $kind -$sidecar handle (stopping: $stopping)",
    async ({ kind, sidecar, stopping }) => {
      const clock = sqliteSchedulerClock();
      const tempDir = tempDirs.make("openclaw-sqlite-wal-split-brain-");
      const databasePath = path.join(tempDir, "state.sqlite");
      fs.writeFileSync(databasePath, "fixture");
      const db = createMockDb();
      const close = vi.spyOn(db, "close");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0));
      const maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 100,
        databaseLabel: "split-brain-test",
        databasePath,
      });
      const prepare = vi.spyOn(db, "prepare");
      prepare.mockClear();
      const inspecting = createDeferredCore();
      const resumeInspection = createDeferredCore();
      const sidecarPath = `${databasePath}-${sidecar}`;
      vi.spyOn(directoryFs, "readdir").mockResolvedValue(["42"]);
      vi.spyOn(fs.promises, "readlink").mockResolvedValue(
        kind === "unlinked" ? `${sidecarPath} (deleted)` : sidecarPath,
      );
      vi.spyOn(fs, "fstat").mockImplementation((_fd, _options, callback) =>
        callback(null, {
          dev: 10n,
          ino: 20n,
          nlink: kind === "unlinked" ? 0n : 1n,
        } as fs.BigIntStats),
      );
      vi.spyOn(fs.promises, "stat").mockImplementation(async (pathname) => {
        if (pathname !== sidecarPath) {
          throw new Error(`unexpected stat: ${String(pathname)}`);
        }
        inspecting.resolve();
        if (stopping) {
          await resumeInspection.promise;
        }
        if (kind === "unlinked") {
          const error = new Error("missing sidecar") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return { dev: 10n, ino: 21n } as fs.BigIntStats;
      });
      const write = vi.spyOn(fs, "writeSync").mockReturnValue(1);
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const abort = vi.spyOn(process, "abort").mockImplementation(() => {
        throw new Error("process abort intercepted");
      });

      const running = clock.advanceBy(100);
      if (stopping) {
        await inspecting.promise;
        const stopped = vi.fn();
        const closing = maintenance.stop().then(stopped);
        try {
          await Promise.resolve();
          expect(stopped).not.toHaveBeenCalled();
        } finally {
          resumeInspection.resolve();
          await closing;
        }
      }
      await running;

      expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
      expect(abort).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.close()).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(
        2,
        expect.stringContaining(`"sidecarPath":"${sidecarPath}"`),
      );
    },
  );

  it.each(["closed", "reused"] as const)(
    "discards a stale mismatch when its descriptor was %s during target inspection",
    async (retirement) => {
      const databasePath = resources.file();
      const db = resources.open(databasePath);
      const identity = fs.statSync(databasePath, { bigint: true });
      const target = createDeferredCore<fs.BigIntStats>();
      const inspecting = createDeferredCore();
      vi.spyOn(directoryFs, "readdir").mockResolvedValue(["42"]);
      vi.spyOn(fs.promises, "readlink").mockResolvedValue(`${databasePath}-wal`);
      const descriptor = vi
        .spyOn(fs, "fstat")
        .mockImplementation((_fd, _options, callback) => callback(null, identity));
      vi.spyOn(fs.promises, "stat").mockImplementation(async () => {
        inspecting.resolve();
        return target.promise;
      });
      const observation = detectSqliteWalSplitBrain(databasePath);
      await inspecting.promise;
      descriptor.mockImplementation((_fd, _options, callback) => {
        if (retirement === "closed") {
          callback(Object.assign(new Error("closed"), { code: "EBADF" }), identity);
        } else {
          callback(null, Object.assign({}, identity, { ino: identity.ino + 1n }));
        }
      });
      target.resolve(Object.assign({}, identity, { ino: identity.ino + 2n }));
      expect(await observation).toBeUndefined();
      expect(db.isOpen).toBe(true);
    },
  );

  it.runIf(process.platform === "linux").each(["main", "worker", "agent", "shared"] as const)(
    "preserves the replacement WAL family across fatal containment and reopen from a %s owner",
    async (thread) => {
      const tempDir = tempDirs.make("openclaw-sqlite-wal-replacement-");
      const databasePath = path.join(tempDir, "state.sqlite");
      const staleCloseMarker = path.join(tempDir, "stale-close-marker");
      const { DatabaseSync } = requireNodeSqlite();
      const registered = thread === "agent" || thread === "shared";
      if (!registered) {
        const seed = new DatabaseSync(databasePath);
        seed.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events (value TEXT PRIMARY KEY);",
        );
        seed.prepare("INSERT INTO events VALUES (?)").run("base");
        seed.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        seed.close();
      }

      const spawnRole = (role: "current" | "stale", readyLine: string) => {
        let stdout = "";
        let stderr = "";
        const survived = createDeferredCore();
        const childRole = role === "current" ? role : thread === "main" ? "stale" : thread;
        const child = spawn(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl(sqliteMaintenanceEntrypoints.walReplacement),
            ),
            childRole,
            databasePath,
            staleCloseMarker,
          ],
          {
            env: { ...process.env, OPENCLAW_TEST_CONSOLE: "1" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        const childStdout = expectDefined(child.stdout, "WAL fixture stdout");
        const childStderr = expectDefined(child.stderr, "WAL fixture stderr");
        const ready = new Promise<void>((resolve, reject) => {
          childStdout.on("data", (chunk) => {
            stdout += chunk;
            if (stdout.includes(readyLine)) {
              resolve();
            }
          });
          child.once("error", reject);
          child.once("close", (code, signal) => {
            if (!stdout.includes(readyLine)) {
              reject(new Error(`${role} exited before ready (${code}/${signal}): ${stderr}`));
            }
          });
        });
        childStderr.on("data", (chunk) => (stderr += chunk));
        child.on("message", (message) => {
          if (message === "survived-tick") {
            survived.resolve();
          }
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        return { child, closed, ready, survived: survived.promise, stderr: () => stderr };
      };

      const stale = spawnRole("stale", "stale-ready");
      let current: ReturnType<typeof spawnRole> | undefined;
      try {
        await stale.ready;
        const originalIdentity = fs.statSync(databasePath, { bigint: true });
        fs.unlinkSync(`${databasePath}-wal`);
        fs.unlinkSync(`${databasePath}-shm`);
        if (registered) {
          fs.unlinkSync(databasePath);
          fs.copyFileSync(`${databasePath}.seed`, databasePath);
          const replacementIdentity = fs.statSync(databasePath, { bigint: true });
          expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
            originalIdentity.dev,
            originalIdentity.ino,
          ]);
        }
        current = spawnRole("current", "current-ready");
        await current.ready;

        let containmentWatchdogFired = false;
        const timeout = setTimeout(() => {
          containmentWatchdogFired = true;
          stale.child.kill("SIGKILL");
        }, 20_000);
        let childResult: Awaited<typeof stale.closed>;
        try {
          if (registered) {
            stale.child.send("tick");
          }
          childResult = await Promise.race([
            stale.closed,
            stale.survived.then(() => {
              throw new Error("Published WAL timer returned before fatal containment");
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }

        expect(childResult, stale.stderr()).toEqual({ code: null, signal: "SIGKILL" });
        expect(containmentWatchdogFired).toBe(false);
        expect(fs.existsSync(staleCloseMarker)).toBe(false);
        const fatalEvents = stale
          .stderr()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
          .filter((event) => event.event === "sqlite_wal_sidecar_identity_mismatch");
        expect(fatalEvents).toHaveLength(1);
        expect(fatalEvents[0]).toMatchObject({
          level: "fatal",
          subsystem: "infra/sqlite-wal",
          message: "SQLite WAL sidecar identity mismatch; terminating without SQLite cleanup",
          databasePath,
          databaseLabel:
            thread === "agent"
              ? "openclaw-agent:main"
              : thread === "shared"
                ? "openclaw-state"
                : "replacement-family-test",
          pid: stale.child.pid,
          descriptorDevice: expect.stringMatching(/^\d+$/u),
          descriptorInode: expect.stringMatching(/^\d+$/u),
        });
        expect([`${databasePath}-wal`, `${databasePath}-shm`]).toContain(
          fatalEvents[0].sidecarPath,
        );

        current.child.kill("SIGKILL");
        await current.closed;
      } finally {
        if (stale.child.exitCode === null && stale.child.signalCode === null) {
          stale.child.kill("SIGKILL");
        }
        await stale.closed;
        if (current && current.child.exitCode === null && current.child.signalCode === null) {
          current.child.kill("SIGKILL");
        }
        if (current) {
          await current.closed;
        }
      }

      const reopened = new DatabaseSync(databasePath);
      try {
        expect(reopened.prepare("PRAGMA integrity_check;").get()).toEqual({
          integrity_check: "ok",
        });
        expect(reopened.prepare("SELECT value FROM events ORDER BY value").all()).toEqual([
          { value: "base" },
          { value: "current" },
        ]);
      } finally {
        reopened.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "linux")(
    "disables split-brain detection after a restricted procfs scan error",
    async () => {
      vi.useFakeTimers();
      const { writer, databasePath } = resources.wal({ checkpointIntervalMs: 100 });
      const prepare = vi.spyOn(writer, "prepare");
      const readdir = vi.spyOn(fs.promises, "readdir").mockImplementationOnce(async () => {
        const error = new Error("restricted procfs");
        (error as NodeJS.ErrnoException).code = "EACCES";
        throw error;
      });
      writer.exec("CREATE TABLE events (value TEXT NOT NULL);");

      await vi.advanceTimersByTimeAsync(100);
      expect(readdir).toHaveBeenCalledTimes(1);
      expect(() => writer.prepare("INSERT INTO events VALUES (?)").run("still-open")).not.toThrow();

      fs.unlinkSync(`${databasePath}-wal`);
      fs.unlinkSync(`${databasePath}-shm`);
      await vi.advanceTimersByTimeAsync(100);

      expect(readdir).toHaveBeenCalledTimes(1);
      expect(
        prepare.mock.calls.filter(([sql]) => sql === "PRAGMA wal_checkpoint(PASSIVE);"),
      ).toHaveLength(2);
      expect(writer.isOpen).toBe(true);
    },
  );

  it("does not run an oversized checkpoint interval immediately", async () => {
    vi.useFakeTimers();
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: Number.MAX_SAFE_INTEGER,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.health).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
    expect(db["exec"]).not.toHaveBeenCalledWith("PRAGMA incremental_vacuum(8);");
    await maintenance.stop();
    maintenance.close();
  });

  it("honors explicit checkpoint mode overrides for periodic and close checkpoints", () => {
    vi.useFakeTimers();
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 100,
      checkpointMode: "FULL",
    });

    vi.advanceTimersByTime(100);
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA wal_checkpoint(FULL);");
    expect(db["exec"]).toHaveBeenCalledWith("PRAGMA incremental_vacuum(8);");

    expect(maintenance.close({ checkpointMode: "PASSIVE" })).toBe(true);
    expect(db["prepare"]).toHaveBeenLastCalledWith("PRAGMA wal_checkpoint(PASSIVE);");
  });

  it("reports checkpoint errors without throwing from background maintenance", () => {
    const db = createMockDb();
    const error = new Error("busy");
    const onCheckpointError = vi.fn();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["prepare"]).mockImplementation((sql) => {
      if (sql.includes("wal_checkpoint")) {
        throw error;
      }
      return {
        get: vi.fn(() => ({
          journal_mode: sql === "PRAGMA journal_mode = WAL;" ? "wal" : "delete",
        })),
      } as unknown as ReturnType<DatabaseSync["prepare"]>;
    });

    const maintenance = configureSqliteWalMaintenance(db, {
      checkpointIntervalMs: 0,
      onCheckpointError,
    });

    expect(maintenance.checkpoint()).toBe(false);
    expect(onCheckpointError).toHaveBeenCalledWith(error);
    expect(maintenance.health).toMatchObject({
      state: "error",
      error: "busy",
      logFrames: null,
      checkpointedFrames: null,
      consecutiveBlocked: 0,
      lastCompletedAtMs: null,
      warning: true,
    });
  });

  it.each([
    { databaseMiB: 1, walMiB: 64, excess: 0, warning: false },
    { databaseMiB: 128, walMiB: 256, excess: 1, warning: true },
  ])(
    "warns on the first blocked checkpoint only above the size-derived limit: $databaseMiB/$walMiB MiB + $excess",
    ({ databaseMiB, walMiB, excess, warning }) => {
      const databasePath = path.join(tempDirs.make("openclaw-wal-health-size-"), "state.sqlite");
      fs.writeFileSync(databasePath, "");
      fs.writeFileSync(`${databasePath}-wal`, "");
      fs.truncateSync(databasePath, databaseMiB * 1024 * 1024);
      fs.truncateSync(`${databasePath}-wal`, walMiB * 1024 * 1024 + excess);
      const db = createMockDb({ busy: 0, log: 8, checkpointed: 5 });
      const maintenance = configureSqliteWalMaintenance(db, {
        databasePath,
        checkpointIntervalMs: 0,
        checkpointMode: "PASSIVE",
      });
      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.health).toMatchObject({
        state: "blocked",
        consecutiveBlocked: 1,
        warning,
      });
    },
  );

  it("retries the WAL transition when SQLite bypasses the busy handler", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let journalModeAttempts = 0;
    vi.mocked(db["prepare"]).mockReturnValue({
      get: vi.fn(() => {
        if (journalModeAttempts++ === 0) {
          throw Object.assign(new Error("database is locked"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 5,
          });
        }
        return { journal_mode: "wal" };
      }),
    } as unknown as ReturnType<DatabaseSync["prepare"]>);

    configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 50,
      checkpointIntervalMs: 0,
    });

    expect(journalModeAttempts).toBe(2);
    expect(
      vi.mocked(db["exec"]).mock.calls.filter(([sql]) => sql.startsWith("PRAGMA busy_timeout")),
    ).toEqual([
      ["PRAGMA busy_timeout = 50"],
      ["PRAGMA busy_timeout = 0"],
      ["PRAGMA busy_timeout = 50"],
    ]);
  });

  it("rejects a WAL transition that SQLite silently declines", () => {
    const db = createMockDb();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(db["prepare"]).mockImplementation(
      (sql) =>
        ({
          get: vi.fn(() => ({
            journal_mode: sql === "PRAGMA journal_mode = WAL;" ? "delete" : "wal",
          })),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    expect(() =>
      configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: 50,
        checkpointIntervalMs: 0,
        databaseLabel: "test-db",
      }),
    ).toThrow("test-db could not enable WAL; SQLite kept journal_mode=delete");
  });

  it("preserves incremental auto-vacuum initialization after empty schema admission", () => {
    const db = resources.open(resources.file(), {}, true);
    admitSqliteSchema(db);
    const probes = resources.count(db, "pageCount", /^PRAGMA page_count$/);

    configureSqlitePreSchemaPragmas(db);

    expect(probes.counts.pageCount).toBe(1);
    expect(db.prepare("PRAGMA auto_vacuum").get()).toMatchObject({ auto_vacuum: 2 });
  });

  it("skips freshness probes for admitted nonempty databases across reopen", () => {
    const pathname = resources.file();
    const db = resources.open(pathname, {}, true);
    admitSqliteSchema(db);
    db.exec(
      "PRAGMA auto_vacuum = FULL; CREATE TABLE payload (value INTEGER); INSERT INTO payload VALUES (7);",
    );
    admitSqliteSchema(db);
    const probes = resources.count(db, "pageCount", /^PRAGMA page_count$/);

    configureSqlitePreSchemaPragmas(db);

    expect(probes.counts.pageCount).toBe(0);
    expect(db.prepare("PRAGMA auto_vacuum").get()).toMatchObject({ auto_vacuum: 1 });
    db.close();

    const reopened = resources.open(pathname, {}, true);
    admitSqliteSchema(reopened);
    const reopenedProbes = resources.count(reopened, "pageCount", /^PRAGMA page_count$/);
    configureSqlitePreSchemaPragmas(reopened);

    expect(reopenedProbes.counts.pageCount).toBe(0);
    expect(reopened.prepare("PRAGMA auto_vacuum").get()).toMatchObject({ auto_vacuum: 1 });
    expect(reopened.prepare("SELECT value FROM payload").get()).toMatchObject({ value: 7 });
  });

  it("configures lock retry before inspecting a fresh database header", () => {
    const db = createMockDb();
    vi.mocked(db["prepare"]).mockImplementation(
      (sql: string) =>
        ({
          get: vi.fn(() => (sql === "PRAGMA page_count" ? { page_count: 0 } : undefined)),
        }) as unknown as ReturnType<DatabaseSync["prepare"]>,
    );

    configureSqlitePreSchemaPragmas(db, { busyTimeoutMs: 5000 });

    expect(db["exec"]).toHaveBeenNthCalledWith(1, "PRAGMA busy_timeout = 5000");
    expect(db["prepare"]).toHaveBeenCalledWith("PRAGMA page_count");
    expect(db["exec"]).toHaveBeenNthCalledWith(2, "PRAGMA auto_vacuum = INCREMENTAL;");
    expect(vi.mocked(db["exec"]).mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        vi.mocked(db["prepare"]).mock.invocationCallOrder[0],
        'vi.mocked(db["prepare"]).mock.invocationCallOrder[0] test invariant',
      ),
    );
  });
});

describe("SQLite connection pragma acquisition", () => {
  it("releases unpublished maintenance when a connection pragma fails", () => {
    const pragma = "synchronous = NORMAL";
    vi.useFakeTimers();
    const dbPath = resources.file();
    const db = resources.open(dbPath);
    const failure = new Error("connection pragma failed");
    db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('committed');");
    const execSpy = spySqliteExec(db, (sql) => {
      if (sql === `PRAGMA ${pragma};`) {
        expect(vi.getTimerCount()).toBe(1);
        throw failure;
      }
    });
    const acquire = () =>
      configureSqliteConnectionPragmas(db, {
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(acquire).toThrow(failure);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.isOpen).toBe(true);
    }
    execSpy.mockRestore();
    const maintenance = acquire();
    try {
      expect(db.prepare("SELECT value FROM payload").all()).toEqual([{ value: "committed" }]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      maintenance.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the pragma failure when maintenance cleanup also throws", () => {
    vi.useFakeTimers();
    const dbPath = resources.file();
    const db = resources.open(dbPath);
    const failure = new Error("connection pragma failed");
    const checkpointFailure = new Error("checkpoint failed");
    const reportFailure = new Error("checkpoint error reporting failed");
    spySqliteExec(db, (sql) => {
      if (sql === "PRAGMA foreign_keys = ON;") {
        throw failure;
      }
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("PRAGMA wal_checkpoint")) {
        throw checkpointFailure;
      }
      return prepare(sql);
    });
    const caught = thrownBy(() => {
      configureSqliteConnectionPragmas(db, {
        databasePath: dbPath,
        foreignKeys: true,
        onCheckpointError: () => {
          throw reportFailure;
        },
      });
    });
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({ cause: failure, errors: [failure, reportFailure] });
    expect(vi.getTimerCount()).toBe(0);
    expect(db.isOpen).toBe(true);
  });
});

it.runIf(process.platform !== "win32").each(["apfs", "unknown", "failed", "aliased"])(
  "preserves a WAL peer through a mount timeout only with canonical APFS evidence: %s",
  (classification) => {
    const root = fs.realpathSync(tempDirs.make("openclaw-wal-mount-timeout-"));
    const directory = path.join(root, "database");
    fs.mkdirSync(directory);
    const alias = path.join(root, "alias");
    if (classification === "aliased") {
      fs.symlinkSync(directory, alias);
    }
    const databasePath = path.join(
      classification === "aliased" ? alias : directory,
      "state.sqlite",
    );
    const first = resources.open(databasePath);
    first.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT);");
    const second = resources.open(databasePath);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("no proc mountinfo");
    });
    vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw Object.assign(new Error("mount classification timed out"), { code: "ETIMEDOUT" });
    });
    vi.mocked(probeTreeClone).mockImplementation(() => {
      if (classification === "failed") {
        throw new Error("native filesystem inspection failed");
      }
      return classification === "unknown" ? undefined : "apfs";
    });
    const configureSecond = () =>
      resources.maintain(second, { databasePath, checkpointIntervalMs: 0 });
    if (classification === "apfs") {
      configureSecond();
      second.exec("INSERT INTO records VALUES ('second');");
    } else {
      expect(configureSecond).toThrow(/database is locked/);
    }
    first.exec("INSERT INTO records VALUES ('first');");
    expect(first.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
    expect(first.prepare("SELECT value FROM records ORDER BY value").all()).toEqual(
      classification === "apfs" ? [{ value: "first" }, { value: "second" }] : [{ value: "first" }],
    );
  },
);
