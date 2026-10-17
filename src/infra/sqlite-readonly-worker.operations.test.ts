import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareAgentSessionStoreDeletionSafety } from "../agents/agent-delete-session-store-safety.targets.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../process/supervisor/cancellation-policy.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../state/openclaw-agent-db.test-support.js";
import * as sqliteRuntime from "./bun-sqlite-library.js";
import { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } from "./diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyWorkerPool } from "./sqlite-readonly-worker-pool.js";
import {
  captureSqliteReadOnlyWorkerLaunch,
  closeSqliteReadOnlyWorkersForBroker,
  createScopedSqliteReadOnlyWorker,
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyOperation,
} from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const scope = createSqliteReadOnlyWorkerScope();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await scope.close();
    await cleanupSnapshotOperations();
    vi.restoreAllMocks();
    cleanup();
  }),
);
let source: string;
let expectedIdentity: string;
let env: NodeJS.ProcessEnv;
let child: ChildProcess;
let sourceDigest: string;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function readCommand(pathname = source) {
  return {
    type: "agentRetirement.sessionStoreBlocker" as const,
    input: prepareAgentSessionStoreDeletionSafety(
      { agents: { entries: { survivor: {} } }, session: { store: pathname } },
      "main",
      env,
    ),
  };
}

function read(signal?: AbortSignal) {
  return scope.run(() =>
    runSqliteReadOnlyOperation(source, readCommand(), {
      source: "canonical",
      expectedIdentity,
      env,
      signal,
    }),
  );
}

beforeAll(async () => {
  const root = tempDirs.make("openclaw-readonly-operations-");
  source = path.join(root, "openclaw-agent.sqlite");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  createCurrentOpenClawAgentDatabaseFixtures(path.join(root, "template.sqlite"), [
    { path: source, agentId: "main" },
  ]);
  expectedIdentity = readDatabasePathIdentitySync(source).key;
  sourceDigest = digest(readFileSync(source));
  await read();
  child = vi.mocked(spawn).mock.results[0]?.value;
});

it("preserves off-thread reads, queued inputs, and cancellation ownership", async ({ signal }) => {
  const sql = [
    ...(["exec", "prepare", "close"] as const).map((method) =>
      vi.spyOn(DatabaseSync.prototype, method),
    ),
    ...(["all", "get", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  try {
    await expect(read()).resolves.toEqual({ blocker: "survivor" });
    expect(digest(readFileSync(source))).toBe(sourceDigest);
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
    }
  } finally {
    for (const operation of sql) {
      operation.mockRestore();
    }
  }
  await waitForDiagnosticEventsDrained();
  const events: DiagnosticWorkerRequestFields[] = [];
  const stop = onInternalDiagnosticEvent(
    (event) => {
      if (event.type === "worker.request" && event.kind === "sqlite_read") {
        events.push(event);
      }
    },
    { include: ["worker.request"] },
  );
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const send = vi.spyOn(child, "send");
  const emit = child.emit.bind(child);
  let paused = createDeferredCore<() => boolean>();
  let pauseNextStart = true;
  const receiving = vi.spyOn(child, "emit").mockImplementation((event, ...args) => {
    const message: unknown = args[0];
    if (
      event === "message" &&
      pauseNextStart &&
      isRecord(message) &&
      isRecord(message.result) &&
      message.result.type === "start"
    ) {
      pauseNextStart = false;
      paused.resolve(() => emit(event, ...args));
      return true;
    }
    return emit(event, ...args);
  });
  const queuedAbort = new AbortController();
  const activeAbort = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    const first = read();
    pending.push(first);
    const release = await withinTest(
      awaitGateBeforeSettlement(paused.promise, first, "Read settled before its transfer started"),
      signal,
    );
    now = 10;
    const prepared = readCommand();
    const command = {
      type: prepared.type,
      input: {
        ...prepared.input,
        synthetic: {
          count: 9_007_199_254_740_993n,
          absent: undefined,
          owners: new Map([["fixture", "captured"]]),
          selected: new Set(["main"]),
        },
      },
    };
    const captured = scope.run(() =>
      runSqliteReadOnlyOperation(source, command, {
        source: "canonical",
        expectedIdentity,
        env,
      }),
    );
    pending.push(captured);
    command.input.agentId = "other";
    command.input.synthetic.count = 1n;
    command.input.synthetic.owners.set("fixture", "changed");
    command.input.synthetic.selected.add("fixture");
    const queuedFailure = new Error("queued ownership read cancelled");
    const queued = read(queuedAbort.signal);
    pending.push(queued);
    const rejectedQueued = expect(queued).rejects.toBe(queuedFailure);
    queuedAbort.abort(queuedFailure);
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)).toMatchObject({ phase: "completed", queueDepth: 1 });
    now = 25;
    release();
    await expect(first).resolves.toEqual({ blocker: "survivor" });
    await expect(captured).resolves.toEqual({ blocker: "survivor" });
    await rejectedQueued;
    const requests = () =>
      send.mock.calls.flatMap(([message]) =>
        isRecord(message) && isRecord(message.operation) ? [message.operation] : [],
      );
    expect(requests()).toHaveLength(2);
    const encoded = requests()[1]?.command;
    if (typeof encoded !== "string") {
      throw new Error("Expected a serialized operation command");
    }
    const decoded: unknown = deserialize(Buffer.from(encoded, "base64"));
    expect(decoded).toMatchObject({
      type: "agentRetirement.sessionStoreBlocker",
      input: { agentId: "main" },
    });
    if (!isRecord(decoded) || !isRecord(decoded.input)) {
      throw new Error("Expected a deserialized operation input");
    }
    expect(decoded.input.synthetic).toStrictEqual({
      count: 9_007_199_254_740_993n,
      absent: undefined,
      owners: new Map([["fixture", "captured"]]),
      selected: new Set(["main"]),
    });

    paused = createDeferredCore<() => boolean>();
    pauseNextStart = true;
    const active = read(activeAbort.signal);
    pending.push(active);
    const activeFailure = new Error("active ownership read cancelled");
    const rejectedActive = expect(active).rejects.toBe(activeFailure);
    await withinTest(
      awaitGateBeforeSettlement(paused.promise, active, "Read settled before cancellation"),
      signal,
    );
    now = 35;
    activeAbort.abort(activeFailure);
    await rejectedActive;
    expect(requests()).toHaveLength(3);
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.connected).toBe(false);
    expect(digest(readFileSync(source))).toBe(sourceDigest);
    expect(spawn).toHaveBeenCalledTimes(1);
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.phase === "queued")).toHaveLength(4);
    expect(events.filter((event) => event.phase === "started")).toHaveLength(3);
    expect(events.filter((event) => event.phase === "completed")).toHaveLength(4);
    expect(Math.max(...events.map((event) => event.queueDepth))).toBe(2);
    expect(events.at(-1)?.queueDepth).toBe(0);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "started", queueWaitMs: 15 }),
        expect.objectContaining({ phase: "completed", durationMs: 25 }),
        expect.objectContaining({ phase: "completed", durationMs: 10 }),
      ]),
    );
  } finally {
    stop();
    clock.mockRestore();
    queuedAbort.abort();
    activeAbort.abort();
    receiving.mockRestore();
    send.mockRestore();
    await scope.close();
    await Promise.allSettled(pending);
  }
});

it("reuses workers across closed scopes without carrying database or inspection state", async () => {
  const root = tempDirs.make("openclaw-readonly-second-");
  const other = path.join(root, "openclaw-agent.sqlite");
  createCurrentOpenClawAgentDatabaseFixtures(path.join(root, "template.sqlite"), [
    { path: other, agentId: "other" },
  ]);
  const start = vi.mocked(spawn).mock.calls.length;
  const query = async (pathname: string, artifactPreserving?: true) => {
    const request = createSqliteReadOnlyWorkerScope();
    try {
      return await request.run(() =>
        runSqliteReadOnlyOperation(pathname, readCommand(pathname), {
          source: "snapshot",
          expectedIdentity: readDatabasePathIdentitySync(pathname).key,
          env,
          artifactPreserving,
        }),
      );
    } finally {
      await request.close();
    }
  };
  await expect(query(source, true)).resolves.toEqual({ blocker: "survivor" });
  await expect(query(other)).resolves.toEqual({ blocker: undefined });
  await expect(
    runSqliteReadOnlyOperation(source, readCommand(), {
      source: "canonical",
      expectedIdentity,
      env,
    }),
  ).resolves.toEqual({ blocker: "survivor" });
  expect(vi.mocked(spawn).mock.calls.length - start).toBe(1);
  const reusedChild = vi.mocked(spawn).mock.results.at(-1)?.value;
  expect(reusedChild.exitCode).toBeNull();
  reusedChild.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    reusedChild.once("close", resolve);
  });
  await expect(query(other)).resolves.toEqual({ blocker: undefined });
  expect(vi.mocked(spawn).mock.calls.length - start).toBe(2);
});

it("closes a queued scope without waiting for an unrelated active transfer", async ({ signal }) => {
  const command = readCommand();
  const options = { source: "canonical" as const, expectedIdentity, env };
  await runSqliteReadOnlyOperation(source, command, options);
  const activeChild = vi.mocked(spawn).mock.results.at(-1)?.value;
  const emit = activeChild.emit.bind(activeChild);
  const paused = createDeferredCore<() => boolean>();
  let pause = true;
  const receiving = vi.spyOn(activeChild, "emit").mockImplementation((event, ...args) => {
    const message: unknown = args[0];
    if (
      event === "message" &&
      pause &&
      isRecord(message) &&
      isRecord(message.result) &&
      message.result.type === "start"
    ) {
      pause = false;
      paused.resolve(() => emit(event, ...args));
      return true;
    }
    return emit(event, ...args);
  });
  const firstScope = createSqliteReadOnlyWorkerScope();
  const secondScope = createSqliteReadOnlyWorkerScope();
  const active = firstScope.run(() => runSqliteReadOnlyOperation(source, command, options));
  const release = await withinTest(
    awaitGateBeforeSettlement(paused.promise, active, "Active read did not reach transfer"),
    signal,
  );
  const queued = secondScope.run(() =>
    runSqliteReadOnlyOperation(
      source,
      {
        type: "pageCache.begin",
        input: { kind: "agent", maxBytes: 1024, now: Date.now() },
      },
      options,
    ),
  );
  const rejected = expect(queued).rejects.toThrow("scope closed");
  let closed = false;
  const closing = secondScope.close().then(() => {
    closed = true;
  });
  try {
    await nextTurn();
    expect(closed).toBe(true);
    await rejected;
    expect(activeChild.exitCode).toBeNull();
  } finally {
    release();
    receiving.mockRestore();
    await Promise.allSettled([active, queued, closing]);
    await firstScope.close();
  }
  await expect(active).resolves.toEqual({ blocker: "survivor" });
});

it("bounds concurrent incompatible launches to four live reader processes", async () => {
  await cleanupSnapshotOperations();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let live = 0;
  let peak = 0;
  vi.mocked(spawn).mockImplementation((...args) => {
    const processChild = actual.spawn(...args);
    peak = Math.max(peak, ++live);
    processChild.once("close", () => {
      live--;
    });
    return processChild;
  });
  try {
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runSqliteReadOnlyOperation(source, readCommand(), {
          source: "canonical",
          expectedIdentity,
          env: { ...env, OPENCLAW_POOL_FIXTURE: String(index) },
        }),
      ),
    );
    expect(rows).toEqual(Array.from({ length: 8 }, () => ({ blocker: "survivor" })));
    expect(peak).toBeLessThanOrEqual(4);
  } finally {
    await cleanupSnapshotOperations();
    vi.mocked(spawn).mockImplementation(actual.spawn);
  }
});

it("quarantines failed cleanup without poisoning healthy capacity or launching a fifth child", async () => {
  await cleanupSnapshotOperations();
  const qualified = sqliteRuntime.getSqliteRuntimeCapabilities();
  const unqualified = { ...qualified, explicitSqliteCloseReleasesNativeResources: false };
  const capabilities = vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
    ...unqualified,
  });
  const sessions: Array<ReturnType<typeof createScopedSqliteReadOnlyWorker>> = [];
  const closeMocks: Array<MockInstance<() => Promise<void>>> = [];
  const failure = new Error("fixture native cleanup is unconfirmed");
  const readPool = createSqliteReadOnlyWorkerPool((launch) => {
    const session = createScopedSqliteReadOnlyWorker(launch);
    sessions.push(session);
    closeMocks.push(vi.spyOn(session, "close").mockRejectedValue(failure));
    return session;
  });
  const launch = captureSqliteReadOnlyWorkerLaunch(env, "canonical");
  const start = vi.mocked(spawn).mock.calls.length;
  const readOwner = () =>
    readPool.run(
      source,
      {
        mode: "operation",
        source: "canonical",
        expectedIdentity,
        env,
        command: readCommand(),
      },
      launch,
    );
  try {
    for (let index = 0; index < 4; index++) {
      await expect(readOwner()).rejects.toThrow("SQLite read and child cleanup failed");
      expect(vi.mocked(spawn).mock.calls.length - start).toBe(index + 1);
      expect(closeMocks[index]).toHaveBeenCalledTimes(2);
      if (index < 3) {
        capabilities.mockReturnValue(qualified);
        await expect(readOwner()).resolves.toEqual({
          operation: "agentRetirement.sessionStoreBlocker",
          value: { blocker: "survivor" },
        });
        capabilities.mockReturnValue(unqualified);
      }
    }
    await expect(readOwner()).rejects.toThrow("capacity is held by unconfirmed cleanup");
    expect(vi.mocked(spawn).mock.calls.length - start).toBe(4);
    for (const close of closeMocks) {
      expect(close).toHaveBeenCalledTimes(2);
    }
  } finally {
    capabilities.mockRestore();
    for (const close of closeMocks) {
      close.mockRestore();
    }
    await Promise.all(sessions.map((session) => session.close()));
  }
});

it.skipIf(process.platform !== "linux")(
  "wakes capacity waiters when leased native cleanup fails",
  async () => {
    const sessions: Array<ReturnType<typeof createScopedSqliteReadOnlyWorker>> = [];
    const closeMocks: Array<MockInstance<() => Promise<void>>> = [];
    const failure = new Error("fixture leased cleanup is unconfirmed");
    const readPool = createSqliteReadOnlyWorkerPool((launch) => {
      const session = createScopedSqliteReadOnlyWorker(launch);
      sessions.push(session);
      closeMocks.push(vi.spyOn(session, "close").mockRejectedValue(failure));
      return session;
    });
    const launch = captureSqliteReadOnlyWorkerLaunch(env, "canonical");
    const warmers = Array.from({ length: 4 }, () => createSqliteReadOnlyWorkerScope());
    const start = vi.mocked(spawn).mock.calls.length;
    try {
      for (const request of warmers) {
        await request.run(() =>
          readPool.run(
            source,
            {
              mode: "operation",
              source: "canonical",
              expectedIdentity,
              env,
              command: {
                type: "pageCache.begin",
                input: { kind: "agent", maxBytes: 1024, now: Date.now() },
              },
            },
            launch,
          ),
        );
      }
      const waiting = readPool.run(
        source,
        {
          mode: "operation",
          source: "canonical",
          expectedIdentity,
          env,
          command: readCommand(),
        },
        launch,
      );
      const rejected = expect(waiting).rejects.toThrow("capacity is held by unconfirmed cleanup");
      for (const request of warmers) {
        await expect(request.close()).rejects.toThrow("scope cleanup failed");
      }
      await rejected;
      expect(vi.mocked(spawn).mock.calls.length - start).toBe(4);
    } finally {
      for (const close of closeMocks) {
        close.mockRestore();
      }
      await Promise.all(sessions.map((session) => session.close()));
      await Promise.allSettled(warmers.map((request) => request.close()));
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps paced page-cache passes isolated from other scopes and launch eviction",
  async () => {
    await cleanupSnapshotOperations();
    const first = createSqliteReadOnlyWorkerScope();
    const second = createSqliteReadOnlyWorkerScope();
    const begin = (request: typeof first) =>
      request.run(() =>
        runSqliteReadOnlyOperation(
          source,
          { type: "pageCache.begin", input: { kind: "agent", maxBytes: 1024, now: Date.now() } },
          { source: "canonical", expectedIdentity, env },
        ),
      );
    try {
      expect((await begin(first)).complete).toBe(false);
      const firstChild: ChildProcess = vi.mocked(spawn).mock.results.at(-1)?.value;
      expect((await begin(second)).complete).toBe(false);
      const secondChild: ChildProcess = vi.mocked(spawn).mock.results.at(-1)?.value;
      expect(secondChild).not.toBe(firstChild);
      for (let index = 0; index < 5; index++) {
        await runSqliteReadOnlyOperation(source, readCommand(), {
          source: "canonical",
          expectedIdentity,
          env: { ...env, OPENCLAW_POOL_FIXTURE: `paced-${index}` },
        });
      }
      const progress = await first.run(() =>
        runSqliteReadOnlyOperation(
          source,
          { type: "pageCache.step", input: null },
          {
            source: "canonical",
            expectedIdentity,
            env,
          },
        ),
      );
      expect(typeof progress.complete).toBe("boolean");
      expect(firstChild.exitCode).toBeNull();
      await second.close();
      expect(secondChild.connected).toBe(false);
      expect(secondChild.exitCode !== null || secondChild.signalCode !== null).toBe(true);
      expect(firstChild.exitCode).toBeNull();
      await first.close();
      expect(firstChild.connected).toBe(false);
      expect(firstChild.exitCode !== null || firstChild.signalCode !== null).toBe(true);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "waits for leased capacity and cancels a waiting scope without disturbing warm passes",
  async ({ signal }) => {
    await cleanupSnapshotOperations();
    const warmers = Array.from({ length: 4 }, () => createSqliteReadOnlyWorkerScope());
    const waiting = createSqliteReadOnlyWorkerScope();
    const aborting = createSqliteReadOnlyWorkerScope();
    const start = vi.mocked(spawn).mock.calls.length;
    try {
      await Promise.all(
        warmers.map((request) =>
          request.run(() =>
            runSqliteReadOnlyOperation(
              source,
              {
                type: "pageCache.begin",
                input: { kind: "agent", maxBytes: 1024, now: Date.now() },
              },
              { source: "canonical", expectedIdentity, env },
            ),
          ),
        ),
      );
      const readOwner = () =>
        runSqliteReadOnlyOperation(source, readCommand(), {
          source: "canonical",
          expectedIdentity,
          env,
        });
      let settled = false;
      const queued = waiting.run(readOwner).then((rows) => {
        settled = true;
        return rows;
      });
      const cancelled = aborting.run(readOwner);
      const rejected = expect(cancelled).rejects.toThrow("scope closed");
      await aborting.close();
      await rejected;
      await nextTurn();
      expect(settled).toBe(false);
      expect(vi.mocked(spawn).mock.calls.length - start).toBe(4);
      await warmers[0]!.close();
      await expect(withinTest(queued, signal)).resolves.toEqual({ blocker: "survivor" });
    } finally {
      await Promise.all([...warmers, waiting, aborting].map((request) => request.close()));
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "retires idle readers through IPC without waiting for broker termination grace",
  async () => {
    const first = createSpawnBrokerHost();
    const second = createSpawnBrokerHost();
    const readerScope = createSqliteReadOnlyWorkerScope();
    const readOwner = () =>
      readerScope.run(() =>
        runSqliteReadOnlyOperation(source, readCommand(), {
          source: "canonical",
          expectedIdentity,
          env,
        }),
      );
    const firstSpawn = vi.spyOn(first, "spawn");
    const secondSpawn = vi.spyOn(second, "spawn");
    try {
      await Promise.all([first.ready(), second.ready()]);
      await runWithSpawnBroker(second, readOwner);
      await runWithSpawnBroker(first, readOwner);
      const firstChild = firstSpawn.mock.results[0]!.value;
      const secondChild = secondSpawn.mock.results[0]!.value;
      expect(firstChild.exitCode).toBeNull();
      expect(secondChild.exitCode).toBeNull();

      const started = performance.now();
      await closeSqliteReadOnlyWorkersForBroker(first);
      await first.close();
      expect(performance.now() - started).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
      expect(firstChild.exitCode).toBe(0);
      expect(firstChild.connected).toBe(false);
      expect(secondChild.exitCode).toBeNull();
      await expect(runWithSpawnBroker(second, readOwner)).resolves.toEqual({ blocker: "survivor" });
      expect(secondSpawn).toHaveBeenCalledTimes(1);
      await expect(runWithSpawnBroker(first, readOwner)).rejects.toThrow("broker is closing");
    } finally {
      try {
        await readerScope.close();
        await Promise.all([
          closeSqliteReadOnlyWorkersForBroker(first),
          closeSqliteReadOnlyWorkersForBroker(second),
        ]);
      } finally {
        await Promise.all([first.close(), second.close()]);
        firstSpawn.mockRestore();
        secondSpawn.mockRestore();
      }
    }
  },
);
