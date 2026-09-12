import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  tryAcquireExclusiveSqliteCoordinator,
  tryAcquireSharedSqliteCoordinator,
} from "./sqlite-coordinator.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
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

  it("bounds idle connections and never evicts a borrowed lock", () => {
    const databases = observeConnections();
    const { location } = fixture();
    const held = tryAcquireExclusiveSqliteCoordinator(location, { keepAlive: true });
    const activeDatabase = firstConnection(databases());
    for (let index = 0; index < 20; index++) {
      tryAcquireExclusiveSqliteCoordinator(fixture().location, { keepAlive: true })?.release();
    }
    expect([...databases()].filter((database) => database.isOpen)).toHaveLength(17);
    expect(activeDatabase.isTransaction).toBe(true);
    held?.release();
    expect([...databases()].filter((database) => database.isOpen)).toHaveLength(16);
    vi.advanceTimersByTime(30 * 60_000);
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
      const params = {
        databasePath: path.join(directory, "state.sqlite"),
        ...(override === "runtimeDirectory"
          ? { runtimeDirectory: directory }
          : { coordinatorPath: location }),
      };
      const coordinator = acquireStateDatabaseCoordinator(params);
      coordinator.release();
      expect([...databases()].every((database) => !database.isOpen)).toBe(true);
      fs.unlinkSync(coordinator.path);
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
