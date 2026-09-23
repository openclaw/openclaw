import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareAgentAuthProfileRowsRead } from "../agents/auth-profiles/sqlite-read.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { GatewayConnectionWork } from "../gateway/server-connection-work.js";
import { BrokerChild } from "../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { SpawnBrokerError } from "../process/spawn-broker/protocol.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyWorker,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});
const skipBroker = process.platform === "win32" || Boolean(process.versions.bun);

function createAuthDatabase(key = "synthetic") {
  const source = path.join(tempDirs.make("openclaw-auth-transport-"), "source.sqlite");
  const store = {
    version: 1,
    profiles: { "fixture:default": { type: "api_key", provider: "fixture", key } },
  };
  const state = { lastGood: { fixture: "fixture:default" } };
  const database = new (requireNodeSqlite().DatabaseSync)(source);
  try {
    database.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    `);
    database
      .prepare("INSERT INTO auth_profile_store VALUES (?, ?)")
      .run("primary", JSON.stringify(store));
    database
      .prepare("INSERT INTO auth_profile_state VALUES (?, ?)")
      .run("primary", JSON.stringify(state));
  } finally {
    database.close();
  }
  return { source, store, state };
}

function read(
  source: string,
  sourceKind: "canonical" | "snapshot",
  signal?: AbortSignal,
  env = { ...process.env },
) {
  return runSqliteReadOnlyWorker(source, {
    mode: "auth-profile-rows",
    source: sourceKind,
    expectedIdentity: readDatabasePathIdentitySync(source).key,
    env,
    coordinatorRuntime: {
      directory: tempDirs.make("openclaw-auth-read-coordinator-"),
      keepAlive: false,
    },
    signal,
  });
}

it("keeps prepared auth source reads and cleanup off the host SQLite thread", async () => {
  const { source, store, state } = createAuthDatabase();
  const before = fs.readFileSync(source);
  const coordinatorDirectory = tempDirs.make("openclaw-auth-source-coordinator-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.dirname(source) };
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let childClosed = false;
  vi.mocked(spawn).mockImplementationOnce((...args) => {
    const child = actual.spawn(...args);
    child.once("close", () => {
      childClosed = true;
    });
    return child;
  });
  const sql = [
    ...(["exec", "prepare", "close"] as const).map((method) =>
      vi.spyOn(DatabaseSync.prototype, method),
    ),
    ...(["all", "get", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  await withStateDatabaseCoordinatorRuntimeDirectory(coordinatorDirectory, async () => {
    const absentPath = path.join(path.dirname(source), "absent.sqlite");
    const absent = prepareAgentAuthProfileRowsRead({
      databasePath: absentPath,
      agentId: "main",
      env,
    });
    const reader = prepareAgentAuthProfileRowsRead({ databasePath: source, agentId: "main", env });
    try {
      await expect(absent.read()).resolves.toEqual({
        store: { status: "missing", reason: "database" },
        state: { status: "missing", reason: "database" },
        cacheable: false,
      });
      expect(fs.existsSync(absentPath)).toBe(false);
      await expect(reader.read()).resolves.toEqual({
        store: { status: "readable", raw: store },
        state: { status: "readable", raw: state },
        cacheable: true,
      });
      expect(childClosed).toBe(true);
    } finally {
      await Promise.all([absent.dispose(), reader.dispose()]);
    }
  });
  for (const operation of sql) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(fs.readFileSync(source)).toEqual(before);
});

describe.each([
  { label: "native", broker: false, sourceKind: "canonical" },
  { label: "broker", broker: true, sourceKind: "canonical" },
  { label: "snapshot with active broker", broker: true, sourceKind: "snapshot" },
] as const)("auth SQLite transport: $label", (transport) => {
  it.skipIf(transport.broker && skipBroker)(
    "serializes fresh auth reads in one scoped child and joins it on close",
    async () => {
      const { source, store, state } = createAuthDatabase();
      const broker = transport.broker ? createSpawnBrokerHost() : undefined;
      try {
        await broker?.ready();
        vi.mocked(spawn).mockClear();
        const brokerSpawn = broker ? vi.spyOn(broker, "spawn") : undefined;
        const reading = () =>
          withSqliteReadOnlyWorkerScope(async () => {
            const rows = await Promise.all(
              Array.from({ length: 4 }, () => read(source, transport.sourceKind)),
            );
            expect(rows).toEqual(
              Array.from({ length: 4 }, () => ({
                store: { status: "readable", raw: store },
                state: { status: "readable", raw: state },
                cacheable: true,
              })),
            );
            const writer = new (requireNodeSqlite().DatabaseSync)(source);
            try {
              writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{}}');
            } finally {
              writer.close();
            }
            expect((await read(source, transport.sourceKind)).state).toEqual({
              status: "readable",
              raw: { lastGood: {} },
            });
            const connection = new GatewayConnectionWork();
            const scheduled = createScheduledGatewayRunner();
            try {
              for (const enter of [
                <T>(run: () => Promise<T>) => connection.track(run),
                scheduled,
              ]) {
                const detachedRows = await runInDetachedAsyncContext(() =>
                  enter(() => read(source, transport.sourceKind)),
                );
                expect(detachedRows).toEqual({
                  store: { status: "readable", raw: store },
                  state: { status: "readable", raw: { lastGood: {} } },
                  cacheable: true,
                });
              }
            } finally {
              await connection.drain();
            }
            const child =
              transport.label === "broker"
                ? brokerSpawn?.mock.results[0]?.value
                : vi.mocked(spawn).mock.results[0]?.value;
            expect(child?.exitCode).toBeNull();
          });
        await (broker ? runWithSpawnBroker(broker, reading) : reading());
        const spawning = transport.label === "broker" ? brokerSpawn! : vi.mocked(spawn);
        expect(spawning).toHaveBeenCalledTimes(1);
        expect(spawning.mock.results[0]?.value.exitCode).toBe(0);
        expect(spawning.mock.results[0]?.value.connected).toBe(false);
      } finally {
        await broker?.close();
      }
    },
  );

  it.skipIf(transport.broker && skipBroker)(
    "reads complete oversized auth rows and joins the child before returning",
    async () => {
      const { source, store, state } = createAuthDatabase(`${"synthetic".repeat(1_200_000)}🌊`);
      const sourceBefore = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
      const broker = transport.broker ? createSpawnBrokerHost() : undefined;
      let child: ChildProcess | undefined;
      let closed = false;
      let stdoutBytes = 0;
      const observe = <T extends ChildProcess>(value: T): T => {
        child = value;
        value.once("close", () => {
          closed = true;
        });
        const capture = () =>
          value.stdout?.on("data", (data: Buffer) => {
            stdoutBytes += data.length;
          });
        if (value instanceof BrokerChild) {
          void value.ready().then(capture, () => {});
        } else {
          capture();
        }
        return value;
      };
      try {
        await broker?.ready();
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.mocked(spawn).mockImplementationOnce((...args) => observe(actual.spawn(...args)));
        if (broker) {
          const brokerSpawn = broker.spawn.bind(broker);
          vi.spyOn(broker, "spawn").mockImplementation((...args) => observe(brokerSpawn(...args)));
          // A previous generation's cleanup error must not poison a new native exit.
          vi.spyOn(broker, "waitForCleanup").mockRejectedValue(
            new Error("prior broker generation cleanup failed"),
          );
        }
        const reading = () => read(source, transport.sourceKind);
        const rows = await (broker ? runWithSpawnBroker(broker, reading) : reading());
        const expected = JSON.stringify({
          store: { status: "readable", raw: store },
          state: { status: "readable", raw: state },
          cacheable: true,
        });
        const received = JSON.stringify(rows);
        expect(received.length).toBe(expected.length);
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        expect(digest(received)).toBe(digest(expected));
        expect(child instanceof BrokerChild).toBe(transport.label === "broker");
        expect(closed).toBe(true);
        expect(child?.exitCode).toBe(0);
        expect(child?.connected).toBe(false);
        expect(stdoutBytes).toBe(0);
        expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(
          sourceBefore,
        );
        const writer = new (requireNodeSqlite().DatabaseSync)(source);
        try {
          writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{}}');
        } finally {
          writer.close();
        }
        const refreshed = await (broker ? runWithSpawnBroker(broker, reading) : reading());
        expect(refreshed.state).toEqual({ status: "readable", raw: { lastGood: {} } });
      } finally {
        vi.restoreAllMocks();
        await broker?.close();
        vi.mocked(spawn).mockReset();
      }
    },
  );
});

it("replaces a scoped auth child when its captured environment or source changes", async () => {
  const { source } = createAuthDatabase();
  const changedEnv = { ...process.env, OPENCLAW_FIXTURE: "changed" };
  await withSqliteReadOnlyWorkerScope(async () => {
    await read(source, "canonical");
    await read(source, "canonical", undefined, changedEnv);
    expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
    await read(source, "snapshot", undefined, changedEnv);
    expect(vi.mocked(spawn).mock.results[1]?.value.exitCode).toBe(0);
  });
  expect(spawn).toHaveBeenCalledTimes(3);
  expect(vi.mocked(spawn).mock.results[2]?.value.exitCode).toBe(0);
});

it("closes a scoped auth child before rejecting queued reads on shutdown", async () => {
  const { source } = createAuthDatabase();
  const scope = createSqliteReadOnlyWorkerScope();
  try {
    await scope.run(() => read(source, "canonical"));
    const pending = scope.run(() =>
      Promise.allSettled([read(source, "canonical"), read(source, "canonical")]),
    );
    await scope.close();
    expect(await pending).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "SQLite read-only worker scope closed" }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "SQLite read-only worker scope closed" }),
      },
    ]);
    await expect(scope.run(() => read(source, "canonical"))).rejects.toThrow("scope closed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.results[0]?.value.connected).toBe(false);
  } finally {
    await scope.close();
  }
});

it("captures queued auth launch facts before FIFO admission", async () => {
  const { source } = createAuthDatabase();
  const env = { ...process.env, OPENCLAW_FIXTURE: "captured" };
  const cwd = process.cwd();
  const changedCwd = tempDirs.make("openclaw-auth-queued-cwd-");
  const scope = createSqliteReadOnlyWorkerScope();
  try {
    const reading = scope.run(() => read(source, "canonical", undefined, env));
    env.OPENCLAW_FIXTURE = "changed after enqueue";
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(changedCwd);
    try {
      await reading;
    } finally {
      cwdSpy.mockRestore();
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    const launch = vi.mocked(spawn).mock.calls[0]?.[2];
    expect.soft(launch?.env?.OPENCLAW_FIXTURE).toBe("captured");
    expect.soft(launch?.cwd).toBe(cwd);
  } finally {
    await scope.close();
  }
});

it.skipIf(skipBroker)(
  "replaces scoped auth transport across broker owners and snapshot sources",
  async () => {
    const { source } = createAuthDatabase();
    const firstBroker = createSpawnBrokerHost();
    const secondBroker = createSpawnBrokerHost();
    const scope = createSqliteReadOnlyWorkerScope();
    try {
      await Promise.all([firstBroker.ready(), secondBroker.ready()]);
      const firstSpawn = vi.spyOn(firstBroker, "spawn");
      const secondSpawn = vi.spyOn(secondBroker, "spawn");
      vi.mocked(spawn).mockClear();
      const reading = (broker: typeof firstBroker, sourceKind: "canonical" | "snapshot") =>
        runWithSpawnBroker(broker, () => scope.run(() => read(source, sourceKind)));
      const first = await reading(firstBroker, "canonical");
      expect(await reading(secondBroker, "canonical")).toEqual(first);
      expect(firstSpawn).toHaveBeenCalledTimes(1);
      expect(secondSpawn).toHaveBeenCalledTimes(1);
      expect(firstSpawn.mock.results[0]?.value.exitCode).toBe(0);

      expect(await reading(secondBroker, "snapshot")).toEqual(first);
      expect(secondSpawn.mock.results[0]?.value.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await reading(secondBroker, "canonical")).toEqual(first);
      expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
      expect(secondSpawn).toHaveBeenCalledTimes(2);
    } finally {
      await scope.close();
      await Promise.all([firstBroker.close(), secondBroker.close()]);
    }
  },
);

describe.skipIf(skipBroker)("auth SQLite broker lifecycle", () => {
  it("retains one native replacement after confirmed scoped broker nonadmission", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    try {
      await broker.ready();
      await broker.close();
      const brokerSpawn = vi.spyOn(broker, "spawn");
      vi.mocked(spawn).mockClear();
      await runWithSpawnBroker(broker, () =>
        withSqliteReadOnlyWorkerScope(async () => {
          const first = await read(source, "canonical");
          expect(await read(source, "canonical")).toEqual(first);
          expect(brokerSpawn).toHaveBeenCalledTimes(1);
          expect(spawn).toHaveBeenCalledTimes(1);
        }),
      );
      expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
    } finally {
      await broker.close();
    }
  });

  it("cancels an admitted read before IPC readiness and joins its child", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    const ready = createDeferredCore();
    const admitted = createDeferredCore<BrokerChild>();
    const abort = new AbortController();
    let reading: Promise<unknown> | undefined;
    try {
      await broker.ready();
      const brokerSpawn = broker.spawn.bind(broker);
      vi.spyOn(broker, "spawn").mockImplementation((...args) => {
        const child = brokerSpawn(...args);
        const actualReady = child.ready();
        vi.spyOn(child, "ready").mockImplementation(() => actualReady.then(() => ready.promise));
        void actualReady.then(() => admitted.resolve(child), admitted.reject);
        return child;
      });
      reading = runWithSpawnBroker(broker, () => read(source, "canonical", abort.signal));
      const failure = new Error("auth read cancelled before readiness");
      const rejected = expect(reading).rejects.toBe(failure);
      const child = await admitted.promise;
      abort.abort(failure);
      await rejected;
      expect(child.signalCode).toBe("SIGKILL");
      expect(child.connected).toBe(false);
    } finally {
      ready.resolve();
      abort.abort();
      await Promise.allSettled([reading]);
      await broker.close();
    }
  });

  it.each(["unavailable", "worker refusal", "cancelled refusal"])(
    "settles confirmed broker nonadmission (%s) before any native replacement",
    async (refusal) => {
      const { source, store, state } = createAuthDatabase();
      const broker = createSpawnBrokerHost();
      let nativeChild: ChildProcess | undefined;
      let nativeClosed = false;
      let proxyClosed = false;
      let nativeOptions: SpawnOptions | undefined;
      let brokerOptions: SpawnOptions | undefined;
      const abort = new AbortController();
      const cancellation = new Error("auth read cancelled after broker refusal");
      const changedCwd = tempDirs.make("openclaw-auth-fallback-cwd-");
      try {
        await broker.ready();
        await broker.close();
        const brokerSpawn = broker.spawn.bind(broker);
        vi.spyOn(broker, "spawn").mockImplementationOnce((command, args, options) => {
          brokerOptions = options;
          const child =
            refusal === "unavailable"
              ? brokerSpawn(command, args, options)
              : new BrokerChild(1, [command, ...args], async () => {});
          child.once("close", () => {
            proxyClosed = true;
            if (refusal === "cancelled refusal") {
              queueMicrotask(() => abort.abort(cancellation));
            } else if (refusal === "worker refusal") {
              vi.spyOn(process, "cwd").mockReturnValue(changedCwd);
            }
          });
          if (refusal !== "unavailable") {
            queueMicrotask(() => {
              child.markNotStarted();
              child.fail(new SpawnBrokerError("Spawn broker request capacity exceeded"));
            });
          }
          return child;
        });
        vi.spyOn(broker, "waitForCleanup").mockRejectedValue(
          new Error("prior broker generation cleanup failed"),
        );
        const actual =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.mocked(spawn).mockImplementationOnce((...args) => {
          nativeOptions = args[2];
          nativeChild = actual.spawn(...args);
          nativeChild.once("close", () => {
            nativeClosed = true;
          });
          return nativeChild;
        });
        const reading = runWithSpawnBroker(broker, () => read(source, "canonical", abort.signal));
        if (refusal === "cancelled refusal") {
          await expect(reading).rejects.toBe(cancellation);
          expect(nativeChild).toBeUndefined();
        } else {
          expect(await reading).toEqual({
            store: { status: "readable", raw: store },
            state: { status: "readable", raw: state },
            cacheable: true,
          });
          expect(nativeClosed).toBe(true);
          expect(nativeChild?.exitCode).toBe(0);
          expect(nativeChild?.connected).toBe(false);
          expect(nativeOptions?.cwd).toBe(brokerOptions?.cwd);
        }
        expect(proxyClosed).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await broker.close();
      }
    },
  );

  it("preserves timeout failure when broker nonadmission arrives afterward", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    let child: BrokerChild | undefined;
    try {
      await broker.ready();
      await broker.close();
      vi.mocked(spawn).mockClear();
      vi.spyOn(broker, "spawn").mockImplementationOnce((command, args) => {
        child = new BrokerChild(1, [command, ...args], async () => {});
        return child;
      });
      const nativeSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
        if (typeof delay !== "number" || delay < 300_000) {
          return nativeSetTimeout(callback, delay, ...args);
        }
        return nativeSetTimeout(() => {
          callback(...args);
          child?.markNotStarted();
          child?.fail(new SpawnBrokerError("Spawn broker request capacity exceeded"));
        }, 0);
      });
      await expect(runWithSpawnBroker(broker, () => read(source, "canonical"))).rejects.toThrow(
        "SQLite read-only snapshot timed out",
      );
      expect(child?.notStarted).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await broker.close();
    }
  });

  it.each([false, true])(
    "starts no child for an aborted read (broker closed: %s)",
    async (closed) => {
      const { source } = createAuthDatabase();
      const broker = createSpawnBrokerHost();
      try {
        await broker.ready();
        if (closed) {
          await broker.close();
        }
        const brokerSpawn = vi.spyOn(broker, "spawn");
        vi.mocked(spawn).mockClear();
        const failure = new Error("auth read already cancelled");
        await expect(
          runWithSpawnBroker(broker, () => read(source, "canonical", AbortSignal.abort(failure))),
        ).rejects.toBe(failure);
        expect(brokerSpawn).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await broker.close();
      }
    },
  );

  it.each([false, true])(
    "retains a failed read until lost-broker cleanup settles (cleanup failure: %s)",
    async (cleanupFails) => {
      const { source } = createAuthDatabase();
      const broker = createSpawnBrokerHost();
      const admitted = createDeferredCore<BrokerChild>();
      const ready = createDeferredCore();
      const cleanupEntered = createDeferredCore();
      const releaseCleanup = createDeferredCore();
      const cleanupFailure = new Error("recorded broker cleanup failure");
      let reading: Promise<unknown> | undefined;
      let settled = false;
      try {
        await broker.ready();
        const brokerSpawn = broker.spawn.bind(broker);
        vi.spyOn(broker, "spawn").mockImplementation((...args) => {
          const child = brokerSpawn(...args);
          const actualReady = child.ready();
          vi.spyOn(child, "ready").mockImplementation(() => actualReady.then(() => ready.promise));
          void actualReady.then(() => admitted.resolve(child), admitted.reject);
          return child;
        });
        const cleanup = broker.waitForCleanup.bind(broker);
        const cleanupSpy = vi.spyOn(broker, "waitForCleanup").mockImplementation(async () => {
          cleanupEntered.resolve();
          await releaseCleanup.promise;
          await cleanup();
          if (cleanupFails) {
            throw cleanupFailure;
          }
        });
        reading = runWithSpawnBroker(broker, () => read(source, "canonical"));
        void reading.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const rejected = cleanupFails
          ? expect(reading).rejects.toMatchObject({
              message: "Auth read and child cleanup failed",
              cause: expect.objectContaining({ message: expect.stringContaining("Spawn broker") }),
              errors: [expect.any(Error), cleanupFailure],
            })
          : expect(reading).rejects.toThrow("Spawn broker");
        const child = await admitted.promise;
        process.kill(broker.pid!, "SIGKILL");
        await cleanupEntered.promise;
        await child.waitForClose();
        expect(settled).toBe(false);
        releaseCleanup.resolve();
        await rejected;
        expect(settled).toBe(true);
        expect(spawn).not.toHaveBeenCalledWith(
          process.execPath,
          expect.arrayContaining([SQLITE_READONLY_CHILD_ARG]),
          expect.anything(),
        );
        cleanupSpy.mockRestore();
      } finally {
        ready.resolve();
        releaseCleanup.resolve();
        await Promise.allSettled([reading]);
        vi.restoreAllMocks();
        await broker.close();
      }
    },
  );
});
