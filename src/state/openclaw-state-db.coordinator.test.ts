import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import * as coordinatorAcquisition from "../infra/state-database-coordinator-acquisition.js";
import {
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "../infra/state-database-coordinator.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
  openClawStateDatabaseCache,
} from "./openclaw-state-db-cache.js";
import { openUnpublishedStateDatabase } from "./openclaw-state-db-open.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

beforeAll(() => {
  expect(isMainThread, "Shared-state host admission requires a real process main thread").toBe(
    true,
  );
});

async function holdStateCoordinator(databasePath: string, releaseAfterMs = 0) {
  // Initialize the real coordinator location/permissions through its owner.
  const coordinator = acquireStateDatabaseCoordinator({ databasePath });
  const coordinatorPath = coordinator.path;
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { DatabaseSync } from "node:sqlite";
    process.title = "openclaw-lock-fixture";
    const db = new DatabaseSync(${JSON.stringify(coordinatorPath)});
    db.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
    process.send({ ready: true });
    process.on("message", (message) => {
      if (message.observe) {
        process.send({ held: db.isTransaction });
        return;
      }
      if (!message.release) return;
      process.removeAllListeners("message");
      setTimeout(() => {
        db.exec("ROLLBACK");
        db.close();
        process.disconnect();
      }, ${releaseAfterMs});
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    expect(message).toEqual({ ready: true });
  } catch (error) {
    await stopChildProcess(child, 5_000);
    throw error;
  }
  const release = async () => {
    try {
      const closed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
      child.send({ release: true });
      await closed;
    } finally {
      await stopChildProcess(child, 5_000);
    }
  };
  return Object.assign(release, {
    pid: child.pid,
    async observe() {
      const observed = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.send({ observe: true });
      const [message] = await observed;
      expect(message).toEqual({ held: true });
    },
  });
}

function openStateDatabaseWithPeriodicMaintenance(databasePath: string) {
  let periodic: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval;
  const interval = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((callback, delay, ...args) => {
      if (delay === 30 * 60 * 1000 && typeof callback === "function") {
        periodic = () => callback(...args);
      }
      return realSetInterval(callback, delay, ...args);
    });
  try {
    const database = openOpenClawStateDatabase({ path: databasePath });
    if (!periodic) {
      throw new Error("Shared-state open did not register periodic WAL maintenance");
    }
    return { database, periodic };
  } finally {
    interval.mockRestore();
  }
}

function observeStateWalCheckpoints(pathname: string) {
  const databasePath = sqliteReaderDatabasePathKey(pathname);
  const observations: string[] = [];
  const waiters = new Set<() => void>();
  const stopObserving = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === databasePath) {
      observations.push(observation.health.state);
      for (const waiter of waiters) {
        waiter();
      }
    }
  });
  return {
    observations,
    stopObserving,
    async waitForObservation(
      this: void,
      predicate: (states: readonly string[]) => boolean,
      timeoutMs: number,
    ) {
      const observed = createDeferred();
      const check = () => {
        if (predicate(observations)) {
          observed.resolve();
        }
      };
      waiters.add(check);
      try {
        check();
        await withTestTimeout(observed.promise, timeoutMs, "WAL checkpoint observation timed out");
      } finally {
        waiters.delete(check);
      }
    },
  };
}

function sqliteBytes(databasePath: string) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const file = databasePath + suffix;
      return [
        suffix,
        fs.existsSync(file)
          ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
          : null,
      ];
    }),
  );
}

describe("shared-state transaction lifecycle participation", () => {
  it.each(["idle", "held"] as const)(
    "closes the %s retirement coordinator only after its last owner releases",
    (custody) => {
      const root = tempDirs.make("openclaw-state-retirement-custody-");
      const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
      const sqlite = requireNodeSqlite();
      const observed = vi.spyOn(sqlite.DatabaseSync.prototype, "exec");
      let coordinatorDatabase: DatabaseSync | undefined;
      let coordinatorPath: string | undefined;
      try {
        const warm = acquireStateDatabaseCoordinator({ databasePath: database.path });
        coordinatorPath = warm.path;
        const connections = new Set(
          observed.mock.contexts.filter((context) => context instanceof sqlite.DatabaseSync),
        );
        expect(connections.size).toBe(1);
        coordinatorDatabase = connections.values().next().value;
        warm.release();
      } finally {
        observed.mockRestore();
      }
      if (!coordinatorDatabase || !coordinatorPath) {
        throw new Error("Warm state coordinator did not expose its native connection");
      }
      const unrelated = acquireStateDatabaseCoordinator({
        databasePath: path.join(root, "unrelated.sqlite"),
        runtimeDirectory: root,
      });
      const peer = new sqlite.DatabaseSync(unrelated.path);
      const outer =
        custody === "held"
          ? acquireStateDatabaseCoordinator({ databasePath: database.path })
          : undefined;
      const samePathPeer = outer ? new sqlite.DatabaseSync(coordinatorPath) : undefined;
      try {
        expect(coordinatorDatabase.isOpen).toBe(true);
        expect(closeOpenClawStateDatabaseByPath(database.path)).toBe(true);
        expect(database.db.isOpen).toBe(false);
        if (outer) {
          expect(coordinatorDatabase.isTransaction).toBe(true);
          expect(() => samePathPeer?.exec("BEGIN EXCLUSIVE")).toThrow(/locked/);
          outer.release();
          samePathPeer?.exec("BEGIN EXCLUSIVE; ROLLBACK");
          samePathPeer?.close();
        }
        expect(coordinatorDatabase.isOpen).toBe(false);
        fs.unlinkSync(coordinatorPath);
        expect(() => peer.exec("BEGIN EXCLUSIVE")).toThrow(/locked/);
        unrelated.release();
        peer.exec("BEGIN EXCLUSIVE; ROLLBACK");
      } finally {
        outer?.release();
        if (samePathPeer?.isOpen) {
          samePathPeer.close();
        }
        unrelated.release();
        peer.close();
        if (coordinatorDatabase.isOpen) {
          coordinatorDatabase.close();
        }
      }
    },
  );

  it.each(
    ["path", "all"].flatMap((scope) =>
      ["cached", "retained"].map((custody) => ({ scope, custody })),
    ),
  )(
    "refuses $scope retirement of a $custody handle before checkpoint or close while another process owns lifecycle exclusion",
    async ({ scope, custody }) => {
      const root = tempDirs.make("openclaw-state-close-coordinator-");
      const options = { path: path.join(root, "openclaw.sqlite") };
      const database = openOpenClawStateDatabase(options);
      runOpenClawStateWriteTransaction((owner) => {
        owner.db
          .prepare(
            "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
          )
          .run("retirement", "retained", "{}", 1);
      }, options);
      const retire = () =>
        scope === "path"
          ? closeOpenClawStateDatabaseByPath(database.path, { busyTimeoutMs: 0 })
          : closeOpenClawStateDatabase({ busyTimeoutMs: 0 });
      if (custody === "retained") {
        const failure = new Error("native close refused");
        const close = vi.spyOn(database.db, "close").mockImplementation(() => {
          throw failure;
        });
        try {
          expect(retire).toThrow(failure);
        } finally {
          close.mockRestore();
        }
      }
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      try {
        expect(retire).toThrow(/state-lifecycle/);
        expect(database.db.isOpen).toBe(true);
        expect(sqliteBytes(database.path)).toEqual(before);
      } finally {
        await release();
      }
      // Refusal retains the actual cache owner; retry closes it only after exclusion ends.
      if (custody === "cached") {
        expect(openOpenClawStateDatabase(options)).toBe(database);
      } else {
        expect(
          openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(database.path),
        ).toBeUndefined();
        expect(() =>
          acquireStateDatabaseHandleExclusion({ databasePath: database.path, busyTimeoutMs: 0 }),
        ).toThrow(/state-handles/);
      }
      retire();
      expect(database.db.isOpen).toBe(false);
      const reopened = openOpenClawStateDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          .all("retirement"),
      ).toEqual([{ event_key: "retained" }]);
    },
  );

  it("waits out brief foreign lifecycle exclusion before default retirement", async () => {
    const root = tempDirs.make("openclaw-state-close-wait-");
    const options = { path: path.join(root, "openclaw.sqlite") };
    const database = openOpenClawStateDatabase(options);
    runOpenClawStateWriteTransaction((owner) => {
      owner.db
        .prepare(
          "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
        )
        .run("retirement", "preserved", "{}", 1);
    }, options);
    const holdMs = 300;
    const release = await holdStateCoordinator(database.path, holdMs);
    const started = performance.now();
    // Start the child's release timer before synchronously waiting in retirement.
    const released = release();
    try {
      closeOpenClawStateDatabase();
      expect(performance.now() - started).toBeGreaterThanOrEqual(holdMs);
      expect(database.db.isOpen).toBe(false);
      expect(
        openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(database.path),
      ).toBeUndefined();
    } finally {
      await released;
    }
    const reopened = openOpenClawStateDatabase(options);
    expect(
      reopened.db
        .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
        .all("retirement"),
    ).toEqual([{ event_key: "preserved" }]);
  });

  it("completes a WAL checkpoint in the same cycle after a 200 ms foreign hold", async () => {
    const root = tempDirs.make("openclaw-state-wal-wait-");
    const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
    const release = await holdStateCoordinator(database.path, 200);
    const released = release();
    try {
      expect(database.walMaintenance.checkpoint()).toBe(true);
      expect(database.walMaintenance.health).toMatchObject({ state: "complete" });
    } finally {
      await released;
    }
  });

  it("keeps the event loop available while periodic WAL maintenance waits for a foreign owner", async () => {
    const root = tempDirs.make("openclaw-state-wal-event-loop-");
    const { database, periodic } = openStateDatabaseWithPeriodicMaintenance(
      path.join(root, "openclaw.sqlite"),
    );
    const release = await holdStateCoordinator(database.path, 200);
    const { observations, stopObserving, waitForObservation } = observeStateWalCheckpoints(
      database.path,
    );
    let released: Promise<void> | undefined;
    try {
      const nextTurn = new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const started = performance.now();
      periodic();
      const callbackMs = performance.now() - started;
      await nextTurn;
      expect(
        observations,
        `Periodic maintenance settled before the next event-loop turn (callback ${callbackMs.toFixed(1)} ms)`,
      ).toEqual([]);
      for (let turn = 0; turn < 3; turn += 1) {
        await release.observe();
        expect(
          observations,
          "Periodic maintenance settled while the foreign owner was still held",
        ).toEqual([]);
      }
      released = release();
      await waitForObservation((states) => states.length > 0, 5_000);
      expect(observations[0]).toBe("complete");
    } finally {
      stopObserving();
      await (released ?? release());
    }
  });

  // Windows cannot rename the directory while SQLite retains its native files.
  it.runIf(process.platform !== "win32")(
    "refuses a physically replaced database after periodic admission waits",
    async () => {
      const root = tempDirs.make("openclaw-state-wal-replacement-");
      const originalDirectory = path.join(root, "original");
      const replacementDirectory = path.join(root, "replacement");
      const displacedDirectory = path.join(root, "displaced");
      const { database, periodic } = openStateDatabaseWithPeriodicMaintenance(
        path.join(originalDirectory, "openclaw.sqlite"),
      );
      const replacement = openOpenClawStateDatabase({
        path: path.join(replacementDirectory, "openclaw.sqlite"),
      });
      replacement.db
        .prepare(
          "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
        )
        .run("replacement", "preserved", "{}", 1);
      await closeOpenClawStateDatabaseByPathAsync(replacement.path);
      const replacementBytes = sqliteBytes(replacement.path);
      const release = await holdStateCoordinator(database.path);
      const { observations, stopObserving, waitForObservation } = observeStateWalCheckpoints(
        database.path,
      );
      let originalMoved = false;
      let replacementInstalled = false;
      let released: Promise<void> | undefined;
      try {
        periodic();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await release.observe();
        expect(observations).toEqual([]);
        fs.renameSync(originalDirectory, displacedDirectory);
        originalMoved = true;
        fs.renameSync(replacementDirectory, originalDirectory);
        replacementInstalled = true;
        released = release();
        await waitForObservation((states) => states.length > 0, 5_000);
        expect(database.walMaintenance.health?.state).toBe("error");
        expect(database.walMaintenance.health?.error).toContain(
          "SQLite database file identity changed before existing-only open",
        );
        expect(observations).toEqual(["error"]);
        expect(sqliteBytes(database.path)).toEqual(replacementBytes);
      } finally {
        stopObserving();
        // Restore both databases and every sidecar before the old handle can checkpoint or close.
        try {
          if (replacementInstalled) {
            fs.renameSync(originalDirectory, replacementDirectory);
            replacementInstalled = false;
          }
          if (originalMoved) {
            fs.renameSync(displacedDirectory, originalDirectory);
            originalMoved = false;
          }
        } finally {
          await (released ?? release());
          if (!originalMoved && !replacementInstalled) {
            await closeOpenClawStateDatabaseByPathAsync(database.path);
          }
        }
      }
    },
  );

  it.each(["synchronous", "asynchronous"] as const)(
    "settles pending periodic maintenance through %s close without crossing foreign lifecycle custody",
    async (mode) => {
      const root = tempDirs.make("openclaw-state-wal-close-");
      const { database, periodic } = openStateDatabaseWithPeriodicMaintenance(
        path.join(root, "openclaw.sqlite"),
      );
      database.db.exec("PRAGMA wal_autocheckpoint=0");
      runOpenClawStateWriteTransaction(
        (owner) => {
          owner.db
            .prepare(
              "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
            )
            .run("maintenance-close", "preserved", "{}", 1);
        },
        { database },
      );
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      const { observations, stopObserving, waitForObservation } = observeStateWalCheckpoints(
        database.path,
      );
      let released: Promise<void> | undefined;
      try {
        periodic();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(observations).toEqual([]);
        if (mode === "synchronous") {
          expect(() =>
            closeOpenClawStateDatabaseByPath(database.path, { busyTimeoutMs: 0 }),
          ).toThrow(/state-lifecycle/);
        } else {
          await expect(
            closeOpenClawStateDatabaseByPathAsync(database.path, { busyTimeoutMs: 0 }),
          ).rejects.toThrow(/state-lifecycle/);
        }
        expect(database.db.isOpen).toBe(true);
        expect(sqliteBytes(database.path)).toEqual(before);
        expect(observations).toEqual([]);
        released = release();
        await released;
        if (mode === "synchronous") {
          // Refused retirement must not cancel the original pending maintenance.
          await waitForObservation((states) => states.length > 0, 5_000);
          expect(observations[0]).toBe("complete");
        } else {
          // A drained admission cannot revive when its old timer callback runs again.
          periodic();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(observations).toEqual([]);
        }
        const beforeRetirement = [...observations];
        await expect(closeOpenClawStateDatabaseByPathAsync(database.path)).resolves.toBe(true);
        expect(database.db.isOpen).toBe(false);
        expect(observations).toEqual([...beforeRetirement, "complete"]);
        const reopened = openOpenClawStateDatabase({ path: database.path });
        expect(
          reopened.db
            .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
            .all("maintenance-close"),
        ).toEqual([{ event_key: "preserved" }]);
      } finally {
        stopObserving();
        await (released ?? release());
        await closeOpenClawStateDatabaseByPathAsync(database.path);
      }
    },
  );

  it("retains failed periodic coordinator cleanup and retries release without replaying maintenance", async () => {
    const root = tempDirs.make("openclaw-state-wal-release-");
    const originalDirectory = path.join(root, "original");
    const successorDirectory = path.join(root, "successor");
    const alias = path.join(root, "current");
    fs.mkdirSync(originalDirectory);
    fs.mkdirSync(successorDirectory);
    fs.symlinkSync(originalDirectory, alias, "junction");
    const { database, periodic } = openStateDatabaseWithPeriodicMaintenance(
      path.join(alias, "openclaw.sqlite"),
    );
    const successor = openOpenClawStateDatabase({
      path: path.join(successorDirectory, "openclaw.sqlite"),
    });
    await closeOpenClawStateDatabaseByPathAsync(successor.path);
    const successorBytes = sqliteBytes(successor.path);
    const sqlite = requireNodeSqlite();
    const observed = vi.spyOn(sqlite.DatabaseSync.prototype, "exec");
    let coordinatorDatabase: DatabaseSync | undefined;
    try {
      const warm = acquireStateDatabaseCoordinator({ databasePath: database.path });
      coordinatorDatabase = observed.mock.contexts.find(
        (context) => context instanceof sqlite.DatabaseSync,
      );
      warm.release();
    } finally {
      observed.mockRestore();
    }
    if (!coordinatorDatabase) {
      throw new Error("Warm state coordinator did not expose its native connection");
    }
    const { observations, stopObserving, waitForObservation } = observeStateWalCheckpoints(
      database.path,
    );
    const releaseObservations: string[][] = [];
    let originalLease:
      | Awaited<ReturnType<typeof coordinatorAcquisition.acquireStateDatabaseCoordinatorWithWait>>
      | undefined;
    const acquireReal = coordinatorAcquisition.acquireStateDatabaseCoordinatorWithWait;
    const acquire = vi
      .spyOn(coordinatorAcquisition, "acquireStateDatabaseCoordinatorWithWait")
      .mockImplementation(async (options) => {
        const lease = await acquireReal(options);
        originalLease ??= lease;
        return lease;
      });
    const closeNative = coordinatorDatabase.close.bind(coordinatorDatabase);
    let failuresRemaining = 2;
    const close = vi.spyOn(coordinatorDatabase, "close").mockImplementation(() => {
      releaseObservations.push([...observations]);
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("Fixture periodic coordinator close failed");
      }
      closeNative();
    });
    try {
      periodic();
      await waitForObservation((states) => states.includes("error"), 1_000);
      expect(database.walMaintenance.health?.state).toBe("error");
      expect(observations).toContain("complete");
      expect(coordinatorDatabase.isOpen).toBe(true);
      expect(coordinatorDatabase.isTransaction).toBe(false);
      expect(() => acquireStateDatabaseCoordinator({ databasePath: database.path })).toThrow(
        "cleanup is pending",
      );
      fs.unlinkSync(alias);
      fs.symlinkSync(successorDirectory, alias, "junction");
      try {
        const settled = observations.length;
        periodic();
        await waitForObservation((states) => states.length > settled, 1_000);
        expect(observations).toHaveLength(settled + 1);
        expect(database.walMaintenance.health?.error).toContain("cleanup is pending");
        expect(coordinatorDatabase.isOpen).toBe(true);
        expect(sqliteBytes(successor.path)).toEqual(successorBytes);
      } finally {
        fs.unlinkSync(alias);
        fs.symlinkSync(originalDirectory, alias, "junction");
      }
      const completed = [...observations];
      await expect(closeOpenClawStateDatabaseByPathAsync(database.path)).rejects.toThrow(
        "failed to release state-lifecycle coordinator",
      );
      expect(database.db.isOpen).toBe(true);
      expect(coordinatorDatabase.isOpen).toBe(true);
      expect(observations).toEqual(completed);
      await expect(closeOpenClawStateDatabaseByPathAsync(database.path)).resolves.toBe(true);
      expect(coordinatorDatabase.isOpen).toBe(false);
      expect(database.db.isOpen).toBe(false);
      expect(releaseObservations.slice(1)).toEqual([completed, completed]);
      expect(observations).toEqual([...completed, "complete"]);
    } finally {
      close.mockRestore();
      acquire.mockRestore();
      stopObserving();
      originalLease?.release();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it.each(["explicit", "periodic"] as const)(
    "defers %s WAL maintenance while lifecycle exclusion is held and retries afterward",
    async (mode) => {
      const root = tempDirs.make("openclaw-state-wal-coordinator-");
      const { database, periodic } = openStateDatabaseWithPeriodicMaintenance(
        path.join(root, "openclaw.sqlite"),
      );
      database.db.exec("PRAGMA wal_autocheckpoint=0");
      runOpenClawStateWriteTransaction(
        (owner) => {
          owner.db
            .prepare(
              "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
            )
            .run("maintenance", "preserved", "{}", 1);
        },
        { database },
      );
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      const { observations, stopObserving, waitForObservation } = observeStateWalCheckpoints(
        database.path,
      );
      try {
        if (mode === "explicit") {
          expect(database.walMaintenance.checkpoint()).toBe(false);
        } else {
          periodic();
          await waitForObservation((states) => states.length > 0, 5_000);
          expect(observations[0]).toBe("blocked");
        }
        if (process.platform === "linux") {
          expect(database.walMaintenance.health).toMatchObject({
            state: "blocked",
            blockingOwner: {
              pid: release.pid,
              startTime: expect.any(Number),
              command: "openclaw-lock-fixture",
              family: "state-lifecycle",
            },
          });
          expect(database.walMaintenance.health?.error).toContain(String(release.pid));
          expect(database.walMaintenance.health?.error).toContain("openclaw-lock-fixture");
        }
        expect(sqliteBytes(database.path)).toEqual(before);
      } finally {
        stopObserving();
        await release();
      }
      expect(database.walMaintenance.checkpoint()).toBe(true);
      expect(sqliteBytes(database.path)).not.toEqual(before);
      expect(
        database.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
          .all("maintenance"),
      ).toEqual([{ event_key: "preserved" }]);
    },
  );

  it("refuses a savepoint in an uncoordinated enclosing transaction", () => {
    const root = tempDirs.make("openclaw-state-uncoordinated-parent-");
    const options = { path: path.join(root, "openclaw.sqlite") };
    const database = openOpenClawStateDatabase(options);
    const callback = vi.fn();
    database.db.exec("BEGIN IMMEDIATE");
    try {
      expect(() => runOpenClawStateWriteTransaction(callback, { ...options, database })).toThrow(
        /uncoordinated.*transaction/i,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(database.db.isTransaction).toBe(true);
    } finally {
      database.db.exec("ROLLBACK");
    }
  });

  it.each(["cached", "supplied"] as const)(
    "refuses a %s writer while another process holds lifecycle exclusion and resumes after release",
    async (handle) => {
      const root = tempDirs.make("openclaw-state-writer-coordinator-");
      const options = { path: path.join(root, "openclaw.sqlite") };
      const database = openOpenClawStateDatabase(options);
      const writeOptions = handle === "supplied" ? { ...options, database } : options;
      const callback = vi.fn(() => {
        database.db
          .prepare(
            "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
          )
          .run("coordinator", "committed", "{}", 1);
      });
      const release = await holdStateCoordinator(database.path);
      const before = sqliteBytes(database.path);
      try {
        expect(() =>
          runOpenClawStateWriteTransaction(callback, writeOptions, { busyTimeoutMs: 0 }),
        ).toThrow(/state-lifecycle/);
        expect(callback).not.toHaveBeenCalled();
        expect(sqliteBytes(database.path)).toEqual(before);
        expect(database.db.isTransaction).toBe(false);
      } finally {
        await release();
      }
      runOpenClawStateWriteTransaction(callback, writeOptions, { busyTimeoutMs: 0 });
      expect(callback).toHaveBeenCalledOnce();
      expect(
        database.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope = ?")
          .all("coordinator"),
      ).toEqual([{ event_key: "committed" }]);
    },
  );
});

it("releases the physical handle lease when connection configuration fails before schema setup", () => {
  const root = tempDirs.make("openclaw-state-open-lease-failure-");
  const pathname = path.join(root, "openclaw.sqlite");
  expect(() =>
    openUnpublishedStateDatabase({
      pathname,
      env: { OPENCLAW_STATE_DIR: root },
      busyTimeoutMs: -1,
      lockFailureReporting: "suppress",
      ensureSchema: () => {
        throw new Error("schema must not run");
      },
      recordOpenFailure: () => {
        throw new Error("configuration is not corruption");
      },
    }),
  ).toThrow(/busyTimeoutMs/);
  const exclusion = acquireStateDatabaseHandleExclusion({
    databasePath: pathname,
    busyTimeoutMs: 0,
  });
  exclusion.release();
});
