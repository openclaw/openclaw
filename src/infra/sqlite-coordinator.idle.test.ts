import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// QA cleanup imports worker-backed stores lazily; admit their inert declarations during collection.
import "./runtime-process-entrypoints.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainSqliteTestSingletons } from "../../test/sqlite-test-lifecycle.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  closeIdleSqliteCoordinators,
  tryAcquireExclusiveSqliteCoordinator,
  tryAcquireSharedSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "./sqlite-handle-lifecycle.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
  acquireStateDatabaseHandleLease,
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const ownerUrl = new URL("./state-database-coordinator.ts", import.meta.url).href;

function observeConnections() {
  const { DatabaseSync } = requireNodeSqlite();
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  return () => new Set(exec.mock.contexts.filter((context) => context instanceof DatabaseSync));
}

function firstConnection(databases: ReadonlySet<DatabaseSync>) {
  const database = databases.values().next().value;
  if (!database) {
    throw new Error("Coordinator did not open a connection");
  }
  return database;
}

function fixture() {
  const directory = tempDirs.make("openclaw-coordinator-idle-");
  const location = path.join(directory, "coordinator.sqlite");
  fs.writeFileSync(location, "");
  return { directory, location };
}

async function holdPeer(location: string) {
  const peer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
    process.send("ready");
    process.once("message", () => { db.exec("ROLLBACK"); db.close(); process.disconnect(); });
  `,
      location,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [message] = await once(peer, "message", { signal: AbortSignal.timeout(5_000) });
    expect(message).toBe("ready");
  } catch (error) {
    await stopChildProcess(peer, 5_000);
    throw error;
  }
  return async () => {
    const exited = once(peer, "exit");
    peer.send("release");
    await exited;
  };
}

describe("idle SQLite coordinator connections", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("reuses released state-handle locks until idle eviction and then reopens", async () => {
    const { directory } = fixture();
    const params = { databasePath: path.join(directory, "state.sqlite") };
    await withStateDatabaseCoordinatorRuntimeDirectory({ directory, keepAlive: true }, async () => {
      acquireStateDatabaseHandleLease({ ...params, keepAlive: false }).release();
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const databases = observeConnections();
      for (let operation = 0; operation < 100; operation++) {
        acquireStateDatabaseHandleLease(params).release();
      }
      expect(open).toHaveBeenCalledTimes(1);
      const database = firstConnection(databases());
      const location = open.mock.calls[0]?.[0];
      if (!location) {
        throw new Error("Coordinator did not open a lock file");
      }
      expect(database.isOpen).toBe(true);
      expect(database.isTransaction).toBe(false);
      const releasePeer = await holdPeer(location);
      await releasePeer();
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(database.isOpen).toBe(true);
      acquireStateDatabaseHandleLease(params).release();
      vi.advanceTimersByTime(1);
      expect(database.isOpen).toBe(true);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(database.isOpen).toBe(false);
      acquireStateDatabaseHandleLease(params).release();
      expect(open).toHaveBeenCalledTimes(2);
      acquireStateDatabaseHandleExclusion(params).release();
      expect([...databases()].every((connection) => !connection.isOpen)).toBe(true);
      fs.unlinkSync(location);
    });
  });

  it("reuses the default state owner connection while releasing each lock and resetting timeout", async () => {
    const { directory } = fixture();
    const params = { databasePath: path.join(directory, "state.sqlite") };
    const first = acquireStateDatabaseCoordinator(params);
    const location = first.path;
    first.release();
    const databases = observeConnections();
    const warm = acquireStateDatabaseCoordinator({ ...params, busyTimeoutMs: 25 });
    warm.release();
    const database = firstConnection(databases());
    expect(database.isOpen).toBe(true);
    expect(database.isTransaction).toBe(false);
    const releasePeer = await holdPeer(location);
    await releasePeer();
    const next = acquireStateDatabaseCoordinator(params);
    expect(databases().size).toBe(1);
    expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    expect(database.isTransaction).toBe(true);
    next.release();
    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(database.isOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(database.isOpen).toBe(false);
    fs.unlinkSync(location);
  });

  it("does not let an old expiry close a checked-out or newly idle owner", () => {
    const { location } = fixture();
    const databases = observeConnections();
    const timer = vi.spyOn(globalThis, "setTimeout");
    tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
    const oldExpiry = timer.mock.calls.at(-1)?.[0];
    const active = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const database = firstConnection(databases());
    if (typeof oldExpiry !== "function") {
      throw new Error("idle expiry was not scheduled");
    }
    oldExpiry();
    expect(database.isOpen).toBe(true);
    expect(database.isTransaction).toBe(true);
    active?.release();
    oldExpiry();
    expect(database.isOpen).toBe(true);
    vi.advanceTimersByTime(30 * 60_000);
    expect(database.isOpen).toBe(false);
  });

  it("drains idle coordinators at the file boundary without closing checked-out owners", async () => {
    const { directory, location } = fixture();
    const heldPath = path.join(directory, "held.sqlite");
    fs.writeFileSync(heldPath, "");
    const timer = vi.spyOn(globalThis, "setTimeout");
    const idle = captureCoordinatorDatabase(() =>
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true }),
    );
    const held = captureCoordinatorDatabase(() =>
      tryAcquireSharedSqliteCoordinator(heldPath, { keepAlive: true }),
    );
    idle.result?.release();
    const expiry = timer.mock.calls.at(-1)?.[0];
    const onError = vi.fn();
    try {
      expect(typeof expiry).toBe("function");
      await drainGlobalSingletonLifecycleState("restart");
      expect(idle.database.isOpen).toBe(true);
      await drainSqliteTestSingletons(onError);
      expect(onError).not.toHaveBeenCalled();
      expect(idle.database.isOpen).toBe(false);
      expect(held.database.isOpen).toBe(true);
      expect(held.database.isTransaction).toBe(true);
      const close = vi.spyOn(idle.database, "close");
      if (typeof expiry === "function") {
        expiry();
      }
      expect(close).not.toHaveBeenCalled();
    } finally {
      held.result?.release({ keepAlive: false });
      closeIdleSqliteCoordinators(directory);
    }
  });

  it.each(["coordinator", "qa-runtime"] as const)(
    "disposes only idle connections inside a removed runtime root through %s",
    async (entryPoint) => {
      const qaCloser =
        entryPoint === "qa-runtime"
          ? (await import("../plugin-sdk/qa-runtime.js")).closeQaRuntimeStores
          : undefined;
      const dispose = async (root: string) => {
        if (qaCloser) {
          await qaCloser(root);
        } else {
          closeIdleSqliteCoordinators(root);
        }
      };
      const { directory } = fixture();
      const root = path.join(directory, "owned");
      fs.mkdirSync(root);
      const idlePath = path.join(root, "idle.sqlite");
      const heldPath = path.join(root, "held.sqlite");
      const otherPath = path.join(directory, "owned-other.sqlite");
      for (const location of [idlePath, heldPath, otherPath]) {
        fs.writeFileSync(location, "");
      }
      const acquire = (location: string) =>
        captureCoordinatorDatabase(() =>
          tryAcquireSharedSqliteCoordinator(location, { keepAlive: true }),
        );
      const idle = acquire(idlePath);
      const held = acquire(heldPath);
      const other = acquire(otherPath);
      idle.result?.release();
      other.result?.release();
      try {
        await dispose(root);
        expect(idle.database.isOpen).toBe(false);
        fs.unlinkSync(idlePath);
        expect(held.database.isOpen).toBe(true);
        expect(held.database.isTransaction).toBe(true);
        expect(other.database.isOpen).toBe(true);
        const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
        const reused = tryAcquireSharedSqliteCoordinator(otherPath, { keepAlive: true });
        try {
          expect(reused).not.toBeNull();
          expect(open).not.toHaveBeenCalled();
        } finally {
          reused?.release();
          open.mockRestore();
        }
        held.result?.release();
        await dispose(root);
        fs.rmSync(root, { recursive: true });
        expect(other.database.isOpen).toBe(true);
      } finally {
        held.result?.release({ keepAlive: false });
        closeIdleSqliteCoordinators(directory);
      }
    },
  );

  it.each([false, true])(
    "retains only unfinished scoped cleanup after close failures (physically closed: %s)",
    (physicallyClosed) => {
      const { directory, location } = fixture();
      const secondPath = path.join(directory, "second.sqlite");
      fs.writeFileSync(secondPath, "");
      const owners = [location, secondPath].map((pathname) => {
        const owner = captureCoordinatorDatabase(() =>
          tryAcquireExclusiveSqliteCoordinator(pathname, { keepAlive: true }),
        );
        owner.result?.release();
        return owner;
      });
      const failures: Error[] = [];
      const closes = owners.map(({ database }, index) => {
        const failure = new Error(`native close ${index} failed`);
        failures.push(failure);
        const close = database.close.bind(database);
        return vi.spyOn(database, "close").mockImplementationOnce(() => {
          if (physicallyClosed) {
            close();
          }
          throw failure;
        });
      });
      try {
        expect(() => closeIdleSqliteCoordinators(directory)).toThrow(
          expect.objectContaining({ errors: failures, cause: failures[0] }),
        );
        for (const { database } of owners) {
          expect(database.isOpen).toBe(!physicallyClosed);
        }
        closeIdleSqliteCoordinators(path.join(directory, "unrelated"));
        for (const close of closes) {
          expect(close).toHaveBeenCalledTimes(1);
        }
        for (const { database } of owners) {
          expect(database.isOpen).toBe(!physicallyClosed);
        }
        // The next explicit disposal recovers retained custody without a timer or a new open.
        closeIdleSqliteCoordinators(directory);
        for (const close of closes) {
          expect(close).toHaveBeenCalledTimes(physicallyClosed ? 1 : 2);
        }
        fs.rmSync(directory, { recursive: true });
      } finally {
        for (const close of closes) {
          close.mockRestore();
        }
        closeIdleSqliteCoordinators(directory);
      }
    },
  );

  it("ends the released lease's custody when its connection enters the idle pool", () => {
    const { location } = fixture();
    const databases = observeConnections();
    const first = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const database = firstConnection(databases());
    first?.release();
    const next = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    try {
      expect(databases().size).toBe(1);
      first?.release();
      first?.release({ keepAlive: false });
      expect(database.isTransaction).toBe(true);
      expect(database.isOpen).toBe(true);
      expect(first?.closed).toBe(true);
      expect(next?.closed).toBe(false);
    } finally {
      next?.release();
    }
    first?.release();
    expect(next?.closed).toBe(true);
    expect(database.isOpen).toBe(true);
    expect(database.isTransaction).toBe(false);
  });

  it.each([false, true])(
    "restores capture-time pooling eligibility independently of ambient scope (canonical: %s)",
    async (canonical) => {
      const { directory } = fixture();
      const defaultRuntime = captureStateDatabaseCoordinatorRuntime();
      const captured = withStateDatabaseCoordinatorRuntimeDirectory(
        canonical ? defaultRuntime : defaultRuntime.directory,
        captureStateDatabaseCoordinatorRuntime,
      );
      const params = { databasePath: path.join(directory, "state.sqlite") };
      withStateDatabaseCoordinatorRuntimeDirectory(captured, () =>
        acquireStateDatabaseCoordinator(params),
      ).release();
      const databases = observeConnections();
      await withStateDatabaseCoordinatorRuntimeDirectory(directory, async () => {
        await Promise.resolve();
        const lease = withStateDatabaseCoordinatorRuntimeDirectory(captured, () =>
          acquireStateDatabaseCoordinator(params),
        );
        expect(lease.path).toBe(
          resolveStateDatabaseCoordinatorPath({
            ...params,
            runtimeDirectory: defaultRuntime.directory,
            uid: typeof process.getuid === "function" ? process.getuid() : undefined,
          }),
        );
        lease.release();
        expect(lease.closed).toBe(true);
        expect(firstConnection(databases()).isOpen).toBe(canonical);
      });
    },
  );

  it("retries a failed pooled release until native close finishes", () => {
    const { location } = fixture();
    const databases = observeConnections();
    const lease = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const database = firstConnection(databases());
    const rollback = vi.spyOn(database, "exec").mockImplementationOnce(() => {
      throw new Error("rollback failed");
    });
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("native close failed");
    });
    try {
      expect(() => lease?.release()).toThrow("rollback and close both failed");
      expect(lease?.closed).toBe(false);
      expect(database.isOpen).toBe(true);
      lease?.release();
      expect(lease?.closed).toBe(true);
      expect(database.isOpen).toBe(false);
      expect(close).toHaveBeenCalledTimes(2);
      const next = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
      try {
        expect(databases().size).toBe(2);
        lease?.release();
        expect(close).toHaveBeenCalledTimes(2);
        expect(next?.closed).toBe(false);
      } finally {
        next?.release();
      }
    } finally {
      rollback.mockRestore();
      close.mockRestore();
      lease?.release();
    }
  });

  it.each([false, true])(
    "retries only unfinished forced-close custody (physically closed: %s)",
    (physicallyClosed) => {
      const { location } = fixture();
      const databases = observeConnections();
      const lease = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
      const database = firstConnection(databases());
      const closeNative = database.close.bind(database);
      const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
        if (physicallyClosed) {
          closeNative();
        }
        throw new Error("forced native close failed");
      });
      const rollback = vi.spyOn(database, "exec");
      rollback.mockClear();
      try {
        expect(() => lease?.release({ keepAlive: false })).toThrow("forced native close failed");
        expect(lease?.closed).toBe(physicallyClosed);
        expect(database.isOpen).toBe(!physicallyClosed);
        lease?.release();
        expect(lease?.closed).toBe(true);
        expect(database.isOpen).toBe(false);
        expect(close).toHaveBeenCalledTimes(physicallyClosed ? 1 : 2);
        expect(rollback).toHaveBeenCalledExactlyOnceWith("ROLLBACK");
        lease?.release({ keepAlive: false });
        expect(close).toHaveBeenCalledTimes(physicallyClosed ? 1 : 2);
      } finally {
        close.mockRestore();
        rollback.mockRestore();
        lease?.release({ keepAlive: false });
      }
    },
  );

  it.each([tryAcquireExclusiveSqliteCoordinator, tryAcquireSharedSqliteCoordinator])(
    "lets a non-retaining acquisition consume and close an idle handle",
    (acquire) => {
      const { location } = fixture();
      const databases = observeConnections();
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
      const database = firstConnection(databases());
      const retirement = acquire(location);
      try {
        expect(databases().size).toBe(1);
        expect(database.isTransaction).toBe(true);
      } finally {
        retirement?.release();
      }
      expect(retirement?.closed).toBe(true);
      expect(database.isOpen).toBe(false);
      fs.unlinkSync(location);
    },
  );

  it.each([false, true])(
    "keeps no-retention sticky until the last held reference releases (retirement first: %s)",
    (retirementFirst) => {
      const { directory } = fixture();
      const params = { databasePath: path.join(directory, "state.sqlite") };
      acquireStateDatabaseCoordinator(params).release();
      const databases = observeConnections();
      const outer = acquireStateDatabaseCoordinator(params);
      const retirement = acquireStateDatabaseCoordinator({ ...params, keepAlive: false });
      const database = firstConnection(databases());
      const [first, last] = retirementFirst ? [retirement, outer] : [outer, retirement];
      try {
        expect(databases().size).toBe(1);
        first.release();
        expect(first.closed).toBe(true);
        expect(database.isTransaction).toBe(true);
        last.release();
        expect(last.closed).toBe(true);
        expect(database.isOpen).toBe(false);
        fs.unlinkSync(last.path);
      } finally {
        outer.release();
        retirement.release();
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["replace", "delete"])(
    "locks the current file after idle pathname %s",
    async (change) => {
      const { directory, location } = fixture();
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
      if (change === "replace") {
        fs.renameSync(location, path.join(directory, "previous.sqlite"));
      } else {
        fs.unlinkSync(location);
      }
      fs.writeFileSync(location, "");
      const release = await holdPeer(location);
      try {
        expect(tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })).toBeNull();
      } finally {
        await release();
      }
      const acquired = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
      expect(acquired).not.toBeNull();
      acquired?.release();
    },
  );

  it("retains every idle connection until expiry and never evicts a borrowed lock", () => {
    const databases = observeConnections();
    const { location } = fixture();
    const held = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const activeDatabase = firstConnection(databases());
    for (let index = 0; index < 20; index++) {
      tryAcquireExclusiveSqliteCoordinator(fixture().location, { keepAlive: true })?.release();
    }
    expect([...databases()].filter((database) => database.isOpen)).toHaveLength(21);
    expect(activeDatabase.isTransaction).toBe(true);
    held?.release();
    expect([...databases()].filter((database) => database.isOpen)).toHaveLength(21);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect([...databases()].some((database) => database.isOpen)).toBe(false);
  });

  it.each([tryAcquireExclusiveSqliteCoordinator, tryAcquireSharedSqliteCoordinator])(
    "keeps unpooled acquisitions immediately removable",
    (acquire) => {
      const { location } = fixture();
      const databases = observeConnections();
      acquire(location)?.release();
      expect([...databases()].every((database) => !database.isOpen)).toBe(true);
      fs.unlinkSync(location);
    },
  );

  it.each(["runtimeDirectory", "coordinatorPath"])(
    "does not retain caller-owned %s",
    (override) => {
      const { directory, location } = fixture();
      const databases = observeConnections();
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const params = {
        databasePath: path.join(directory, "state.sqlite"),
        ...(override === "runtimeDirectory"
          ? { runtimeDirectory: directory }
          : { coordinatorPath: location }),
      };
      for (const acquire of [acquireStateDatabaseCoordinator, acquireStateDatabaseHandleLease]) {
        acquire(params).release();
        expect([...databases()].every((database) => !database.isOpen)).toBe(true);
        const pathname = open.mock.calls.at(-1)?.[0];
        if (!pathname) {
          throw new Error("Coordinator did not open a lock file");
        }
        fs.unlinkSync(pathname);
      }
    },
  );

  it.each(["runtimeDirectory", "coordinatorPath", "keepAlive"] as const)(
    "rechecks idle eligibility after an authority callback changes %s",
    (override) => {
      const { directory } = fixture();
      const params: Parameters<typeof acquireStateDatabaseCoordinator>[0] = {
        databasePath: path.join(directory, "state.sqlite"),
      };
      const prepared = acquireStateDatabaseCoordinator({
        databasePath: params.databasePath,
        runtimeDirectory: override === "keepAlive" ? undefined : directory,
        keepAlive: false,
      });
      const expectedPath = prepared.path;
      prepared.release();
      const exclusion = acquireStateDatabaseHandleExclusion(params);
      let changeRuntime = false;
      let coordinatorPath: string | undefined;
      try {
        exclusion.runWithCanonicalWrites(
          () => {
            if (changeRuntime) {
              if (override === "runtimeDirectory") {
                params.runtimeDirectory = directory;
              } else if (override === "coordinatorPath") {
                params.coordinatorPath = expectedPath;
              } else {
                params.keepAlive = false;
              }
            }
          },
          () => {
            changeRuntime = true;
            const databases = observeConnections();
            const coordinator = acquireStateDatabaseCoordinator(params);
            coordinatorPath = coordinator.path;
            coordinator.release();
            expect(coordinatorPath).toBe(expectedPath);
            expect(databases().size).toBe(1);
            expect([...databases()].every((database) => !database.isOpen)).toBe(true);
          },
        );
      } finally {
        exclusion.release();
      }
      expect(coordinatorPath).toBeDefined();
      if (coordinatorPath) {
        fs.unlinkSync(coordinatorPath);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reopens an idle file after its access mode changes",
    () => {
      const { location } = fixture();
      const databases = observeConnections();
      fs.chmodSync(location, 0o600);
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
      const previous = firstConnection(databases());
      fs.chmodSync(location, 0o640);
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
      expect(previous.isOpen).toBe(false);
      expect(databases().size).toBe(2);
    },
  );

  it("falls back to a fresh connection when filesystem identity is unknown", () => {
    const { location } = fixture();
    const databases = observeConnections();
    const unknown = Object.assign(fs.lstatSync(location, { bigint: true }), { dev: 0n, ino: 0n });
    vi.spyOn(fs, "lstatSync").mockReturnValue(unknown);
    for (let attempt = 0; attempt < 2; attempt++) {
      tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
    }
    expect(databases().size).toBe(2);
    expect([...databases()].every((database) => !database.isOpen)).toBe(true);
  });

  it.each(["throws", "remains open"])("discards a transaction when rollback %s", (failure) => {
    const { location } = fixture();
    const databases = observeConnections();
    const lease = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const database = firstConnection(databases());
    const exec = database.exec.bind(database);
    const rollback = vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") {
        if (failure === "throws") {
          throw new Error("rollback failed");
        }
        return;
      }
      exec(sql);
    });
    expect(() => lease?.release()).toThrow(/rollback/);
    rollback.mockRestore();
    expect(database.isOpen).toBe(false);
    const replacements = observeConnections();
    const next = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const replacement = firstConnection(replacements());
    expect(replacement === database).toBe(false);
    expect(replacement.isTransaction).toBe(true);
    next?.release();
  });

  it("warns on idle close failure, refuses reuse, and retains cleanup for process exit", () => {
    const { location } = fixture();
    const existingExitListeners = new Set(process.listeners("exit"));
    const databases = observeConnections();
    tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
    const database = firstConnection(databases());
    const exitClose = process
      .listeners("exit")
      .find((listener) => !existingExitListeners.has(listener));
    expect(exitClose).toBeDefined();
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("native close failed");
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.advanceTimersByTime(30 * 60_000);
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Idle SQLite coordinator close failed" }),
    );
    expect(database.isOpen).toBe(true);
    tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true })?.release();
    expect(databases().size).toBe(2);
    close.mockRestore();
    exitClose?.(0);
    expect([...databases()].every((connection) => !connection.isOpen)).toBe(true);
    expect(process.listeners("exit")).not.toContain(exitClose);
  });

  it("does not keep an idle expiry attached to a request or keep the process alive", () => {
    const { directory } = fixture();
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        loader,
        "--input-type=module",
        "--eval",
        `
      import { AsyncLocalStorage, createHook } from "node:async_hooks";
      import { acquireStateDatabaseCoordinator } from ${JSON.stringify(ownerUrl)};
      const params = { databasePath: process.argv[1] };
      acquireStateDatabaseCoordinator(params).release();
      const request = new AsyncLocalStorage();
      const observed = [];
      const hook = createHook({ init(id, type, trigger, resource) {
        if (type === "Timeout") observed.push({ resource, context: request.getStore() });
      }}).enable();
      request.run("request", () => acquireStateDatabaseCoordinator(params).release());
      hook.disable();
      process.stdout.write(JSON.stringify(observed.map(({ resource, context }) => ({
        context: context ?? null, referenced: resource.hasRef()
      }))));
    `,
        path.join(directory, "state.sqlite"),
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(JSON.parse(result)).toEqual([{ context: null, referenced: false }]);
  });
});
