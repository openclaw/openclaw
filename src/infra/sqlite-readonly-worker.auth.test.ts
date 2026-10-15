import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  bindAuthProfileFileObservationReaders,
  readAuthProfileDatabaseIdentity,
  refreshAuthProfileFileState,
  registerAuthProfileFileChangeListener,
} from "../agents/auth-profiles/file-state.js";
import { watchAuthProfileNativeCommits } from "../agents/auth-profiles/store-update-commit.js";
import { resolveStateDir } from "../config/state-dir.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { GatewayConnectionWork } from "../gateway/server-connection-work.js";
import { BrokerChild } from "../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { SpawnBrokerError } from "../process/spawn-broker/protocol.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { revokeAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { ensureOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db-schema.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyOperation,
  runSqliteReadOnlyWorker,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await cleanupSnapshotOperations();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});
const skipBroker = process.platform === "win32";

it.skipIf(skipBroker)(
  "reuses the Gateway reader through detached observations and retained-state restart",
  async () => {
    vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("synthetic unavailable watcher");
    });
    const { source, store } = createAuthDatabase();
    const writer = openNodeSqliteDatabase(source);
    admitSqliteSchema(writer);
    const broker = createSpawnBrokerHost();
    const scope = createSqliteReadOnlyWorkerScope();
    const restartedScope = createSqliteReadOnlyWorkerScope();
    let publication: ReturnType<typeof watchAuthProfileNativeCommits> | undefined;
    let pendingRefresh: Promise<void> | undefined;
    const observed: unknown[] = [];
    let refresh = () => read(source, "canonical");
    const unsubscribe = registerAuthProfileFileChangeListener(async ({ directory }) => {
      if (directory !== path.dirname(source)) {
        return;
      }
      const rows = await refresh();
      observed.push(rows.store);
      // Credential publication can replace the observation's refresh callback.
      refresh = () => read(source, "canonical");
    });
    try {
      await broker.ready();
      const brokerSpawn = vi.spyOn(broker, "spawn");
      vi.mocked(spawn).mockClear();
      runWithSpawnBroker(broker, () => scope.run(() => readAuthProfileDatabaseIdentity(source)));
      writer
        .prepare("UPDATE auth_profile_state SET state_json = ?")
        .run('{"lastGood":{"fixture":"fixture-next"}}');
      await runInDetachedAsyncContext(refreshAuthProfileFileState);
      const rotated = { ...store, profiles: {} };
      writer.prepare("UPDATE auth_profile_store SET store_json = ?").run(JSON.stringify(rotated));
      await runInDetachedAsyncContext(refreshAuthProfileFileState);
      clearAuthState(source);
      await runInDetachedAsyncContext(refreshAuthProfileFileState);
      expect(observed).toEqual([
        { status: "readable", raw: store },
        { status: "readable", raw: rotated },
        { status: "readable", raw: rotated },
      ]);
      expect(brokerSpawn).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      publication = watchAuthProfileNativeCommits(source);
      pendingRefresh = runInDetachedAsyncContext(refreshAuthProfileFileState);
      await scope.close();
      expect(brokerSpawn.mock.results[0]?.value.exitCode).toBeNull();
      expect(observed).toHaveLength(3);
      runWithSpawnBroker(broker, () => restartedScope.run(bindAuthProfileFileObservationReaders));
      writer.prepare("UPDATE auth_profile_store SET store_json = ?").run(JSON.stringify(store));
      publication.dispose();
      await pendingRefresh;
      expect(observed).toHaveLength(4);
      expect(observed[3]).toEqual({ status: "readable", raw: store });
      expect(brokerSpawn).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      await restartedScope.close();
      expect(brokerSpawn.mock.results[0]?.value.exitCode).toBeNull();
      clearAuthState(source);
      await runInDetachedAsyncContext(refreshAuthProfileFileState);
      expect(observed).toHaveLength(4);
    } finally {
      publication?.dispose();
      await Promise.allSettled(pendingRefresh ? [pendingRefresh] : []);
      unsubscribe();
      await closeOpenClawStateDatabaseAsync();
      await scope.close();
      await restartedScope.close();
      await broker.close();
      writer.close();
    }
  },
);

function createAuthDatabase(key = "synthetic", metadata?: Record<string, string>) {
  const source = path.join(tempDirs.make("openclaw-auth-transport-"), "source.sqlite");
  const store = {
    version: 1,
    profiles: {
      "fixture:default": {
        type: "api_key",
        provider: "fixture",
        key,
        ...(metadata ? { metadata } : {}),
      },
    },
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
  return {
    source,
    store,
    rows: {
      store: { status: "readable", raw: store },
      state: { status: "readable", raw: state },
      cacheable: true,
    },
  };
}

function clearAuthState(source: string) {
  const writer = new (requireNodeSqlite().DatabaseSync)(source);
  try {
    writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{}}');
  } finally {
    writer.close();
  }
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
    signal,
  });
}

it("rejects stale auth identity before transferring credentials from a replaced database", async () => {
  const { source } = createAuthDatabase("original");
  const replacement = createAuthDatabase("replacement");
  const expectedIdentity = readDatabasePathIdentitySync(source).key;
  await withSqliteReadOnlyWorkerScope(async () => {
    await read(source, "canonical");
    const child: ChildProcess = vi.mocked(spawn).mock.results[0]?.value;
    const replies: unknown[] = [];
    child.on("message", (message: unknown) => replies.push(message));
    fs.renameSync(source, `${source}.retired`);
    fs.renameSync(replacement.source, source);
    await expect(
      runSqliteReadOnlyWorker(source, {
        mode: "auth-profile-rows",
        source: "canonical",
        expectedIdentity,
        env: { ...process.env },
      }),
    ).rejects.toThrow("identity changed");
    expect(replies).toEqual([
      {
        id: expect.any(Number),
        result: { ok: false, message: expect.stringContaining("identity changed") },
      },
    ]);
    expect((await read(source, "canonical")).store).toEqual({
      status: "readable",
      raw: replacement.store,
    });
  });
});

it("observes agent initialization after a cold auth read in the same worker", async () => {
  const root = tempDirs.make("openclaw-auth-bootstrap-");
  const source = path.join(root, "openclaw-agent.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  new (requireNodeSqlite().DatabaseSync)(source).close();
  const expectedIdentity = readDatabasePathIdentitySync(source).key;
  const store = {
    version: 1,
    profiles: {
      "fixture:default": { type: "api_key", provider: "fixture", key: "synthetic" },
    },
  };
  await withSqliteReadOnlyWorkerScope(async () => {
    expect(await read(source, "canonical", undefined, env)).toMatchObject({
      store: { status: "missing", reason: "table" },
      state: { status: "missing", reason: "table" },
    });
    const child = vi.mocked(spawn).mock.results[0]?.value;
    using database = openNodeSqliteDatabase(source);
    ensureOpenClawAgentDatabaseSchema(database, { agentId: "main", path: source, env });
    database
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("plugin-model-catalog-v1", "fixture", "synthetic catalog", 1);
    database
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("primary", JSON.stringify(store), 1);
    await expect(
      runSqliteReadOnlyOperation(
        source,
        { type: "pluginCatalog.read", input: { agentId: "main", pluginIds: ["fixture"] } },
        { source: "canonical", expectedIdentity, env },
      ),
    ).resolves.toEqual([{ pluginId: "fixture", contents: "synthetic catalog" }]);
    expect((await read(source, "canonical", undefined, env)).store).toEqual({
      status: "readable",
      raw: store,
    });
    expect(child.connected).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe.each([
  { label: "native", broker: false, sourceKind: "snapshot" },
  { label: "broker", broker: true, sourceKind: "canonical" },
] as const)("auth SQLite transport: $label", (transport) => {
  it.skipIf(transport.broker && skipBroker)(
    "serializes fresh auth reads and retains the process across scope close",
    async () => {
      const { source, store, rows: expectedRows } = createAuthDatabase();
      const writer = openNodeSqliteDatabase(source);
      admitSqliteSchema(writer);
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
            expect(rows).toEqual(Array.from({ length: 4 }, () => expectedRows));
            writer.prepare("UPDATE auth_profile_state SET state_json = ?").run('{"lastGood":{}}');
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
            writer.exec("DROP TABLE auth_profile_state");
            expect((await read(source, transport.sourceKind)).state).toEqual({
              status: "missing",
              reason: "table",
            });
            writer.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
            expect(await read(source, transport.sourceKind)).toEqual({
              store: { status: "unreadable" },
              state: { status: "unreadable" },
              cacheable: false,
            });
            const child =
              transport.label === "broker"
                ? brokerSpawn?.mock.results[0]?.value
                : vi.mocked(spawn).mock.results[0]?.value;
            expect(child?.exitCode).toBeNull();
          });
        await (broker ? runWithSpawnBroker(broker, reading) : reading());
        const spawning = transport.label === "broker" ? brokerSpawn! : vi.mocked(spawn);
        expect(spawning).toHaveBeenCalledTimes(1);
        expect(spawning.mock.results[0]?.value.exitCode).toBeNull();
        await cleanupSnapshotOperations();
        expect(spawning.mock.results[0]?.value.connected).toBe(false);
      } finally {
        writer.close();
        await broker?.close();
      }
    },
  );

  it.skipIf(transport.broker && skipBroker)(
    "reads oversized auth fields in bounded records without retiring the idle process",
    async () => {
      const { source, rows: expectedRows } = createAuthDatabase(
        `${"synthetic".repeat(1_200_000)}🌊`,
        { ["m".repeat(65_536)]: "synthetic-metadata" },
      );
      const sourceBefore = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
      const broker = transport.broker ? createSpawnBrokerHost() : undefined;
      let child: ChildProcess | undefined;
      let closed = false;
      let stdoutBytes = 0;
      let largestRecordBytes = 0;
      const observe = <T extends ChildProcess>(value: T): T => {
        child = value;
        value.on("message", (message: unknown) => {
          if (
            isRecord(message) &&
            isRecord(message.result) &&
            isRecord(message.result.frame) &&
            typeof message.result.frame.recordBytes === "number"
          ) {
            largestRecordBytes = Math.max(largestRecordBytes, message.result.frame.recordBytes);
          }
        });
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
        const expected = JSON.stringify(expectedRows);
        const received = JSON.stringify(rows);
        expect(received.length).toBe(expected.length);
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        expect(digest(received)).toBe(digest(expected));
        expect(child instanceof BrokerChild).toBe(transport.label === "broker");
        expect(closed).toBe(false);
        expect(child?.exitCode).toBeNull();
        expect(child?.connected).toBe(true);
        expect(stdoutBytes).toBe(0);
        expect(largestRecordBytes).toBeGreaterThan(0);
        expect(largestRecordBytes).toBeLessThanOrEqual(64 * 1024);
        expect(createHash("sha256").update(fs.readFileSync(source)).digest("hex")).toBe(
          sourceBefore,
        );
        clearAuthState(source);
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

it("reuses equivalent state roots and separates changed auth environments", async () => {
  const { source } = createAuthDatabase();
  const implicitEnv = { ...process.env };
  delete implicitEnv.OPENCLAW_STATE_DIR;
  const explicitEnv = { ...implicitEnv, OPENCLAW_STATE_DIR: resolveStateDir(implicitEnv) };
  const changedEnv = { ...implicitEnv, OPENCLAW_FIXTURE: "changed" };
  const changedRoot = { ...changedEnv, OPENCLAW_STATE_DIR: path.dirname(source) };
  await withSqliteReadOnlyWorkerScope(async () => {
    await read(source, "canonical", undefined, implicitEnv);
    await read(source, "canonical", undefined, explicitEnv);
    expect(spawn).toHaveBeenCalledTimes(1);
    await read(source, "canonical", undefined, changedEnv);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.results.at(-1)?.value.exitCode).toBeNull();
    await read(source, "canonical", undefined, changedRoot);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(spawn).mock.results.at(-1)?.value.exitCode).toBeNull();
    await read(source, "snapshot", undefined, changedRoot);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(spawn).mock.results.at(-1)?.value.exitCode).toBeNull();
  });
  expect(spawn).toHaveBeenCalledTimes(3);
  await cleanupSnapshotOperations();
  for (const child of vi.mocked(spawn).mock.results) {
    expect(child.value.exitCode ?? child.value.signalCode).not.toBeNull();
  }
});

it("rejects queued reads on scope shutdown without stopping the shared idle child", async () => {
  const { source } = createAuthDatabase();
  const scope = createSqliteReadOnlyWorkerScope();
  try {
    await scope.run(() => read(source, "canonical"));
    const pending = scope.run(() =>
      Promise.allSettled([read(source, "canonical"), read(source, "canonical")]),
    );
    await scope.close();
    expect(await pending).toEqual(
      Array.from({ length: 2 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({ message: "SQLite read-only worker scope closed" }),
      })),
    );
    await expect(scope.run(() => read(source, "canonical"))).rejects.toThrow("scope closed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.results[0]?.value.connected).toBe(true);
  } finally {
    await scope.close();
  }
});

it("releases request readers before agent database removal", async () => {
  const { source } = createAuthDatabase();
  await withSqliteReadOnlyWorkerScope(async () => {
    await read(source, "canonical");
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    expect(child).toBeDefined();
    expect(child?.exitCode).toBeNull();
    await Promise.all(revokeAgentDatabaseResources({ path: source }));
    expect(child?.exitCode).toBeNull();
    fs.unlinkSync(source);
    expect(fs.existsSync(source)).toBe(false);
  });
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

      expect(await reading(secondBroker, "snapshot")).toEqual(first);
      expect(secondSpawn.mock.results[0]?.value.exitCode).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      expect(await reading(secondBroker, "canonical")).toEqual(first);
      expect(secondSpawn).toHaveBeenCalledTimes(1);
    } finally {
      await scope.close();
      await Promise.all([firstBroker.close(), secondBroker.close()]);
    }
  },
);

describe.skipIf(skipBroker)("auth SQLite broker lifecycle", () => {
  it("reports broker nonadmission without spawning on the request thread", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    await broker.ready();
    await broker.close();
    vi.mocked(spawn).mockClear();
    await expect(runWithSpawnBroker(broker, () => read(source, "canonical"))).rejects.toMatchObject(
      {
        code: "ERR_SPAWN_BROKER_UNAVAILABLE",
      },
    );
    expect(spawn).not.toHaveBeenCalled();
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

  it("starts no child for an aborted read", async () => {
    const { source } = createAuthDatabase();
    const broker = createSpawnBrokerHost();
    try {
      await broker.ready();
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
  });

  it.each([false, true])(
    "retains a failed read until lost-broker cleanup settles (cleanup failure: %s)",
    async (cleanupFails) => {
      const { source, rows } = createAuthDatabase();
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
        const spawning = vi.spyOn(broker, "spawn").mockImplementation((...args) => {
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
              message: "SQLite read and child cleanup failed",
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
        if (cleanupFails) {
          cleanupSpy.mockRestore();
          ready.resolve();
          await broker.ready();
          const launches = spawning.mock.calls.length;
          await expect(
            runWithSpawnBroker(broker, () => read(source, "canonical")),
          ).resolves.toEqual(rows);
          expect(spawning).toHaveBeenCalledTimes(launches + 1);
        }
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
