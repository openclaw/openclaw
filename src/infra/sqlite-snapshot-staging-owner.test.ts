import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RetainedWorkerTask } from "@openclaw/worker-runtime";
import {
  createRetainedOperation,
  flatMapRetainedOperation,
  type NativeWorkerEvents,
  type RetainedOperation,
  type RetainedOutcome,
} from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import {
  cleanupSnapshotOperations,
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import { waitForGate } from "./sqlite-snapshot-staging-owner.test-support.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";
import type {
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
} from "./worker-task-pool.types.js";

type Gate = {
  entered: ReturnType<typeof createDeferredCore<void>>;
  open: boolean;
  advance?: () => void;
};
type ReleaseGate = Gate & { ordinal: number };
type ReplyGate = Gate & {
  kind: "allocated" | "prepared";
  directory?: string;
};
const requestContext = new AsyncLocalStorage<string>();
const observation = {
  tasks: 0,
  admitted: [] as unknown[],
  allocated: [] as string[],
  gate: undefined as ReleaseGate | undefined,
  replyGate: undefined as ReplyGate | undefined,
  taskReads: new Map<number, () => RetainedOutcome<unknown>>(),
  releaseContexts: new Map<number, string | undefined>(),
  snapshots: new Set<() => { workers: number; activeTasks: number; pendingTasks: number }>(),
};

type NativeSubscription = {
  [Event in keyof NativeWorkerEvents]: [Event, (...args: NativeWorkerEvents[Event]) => void];
}[keyof NativeWorkerEvents];

function observeNativeReplies(native: RetainedNativeWorker): RetainedNativeWorker {
  const on = native.on.bind(native);
  const listen: RetainedNativeWorker["on"] = (...[event, listener]: NativeSubscription) => {
    if (event !== "message") {
      // EventEmitter.once also forwards its exit subscription through this method.
      return Reflect.apply(on, native, [event, listener]);
    }
    return on("message", (message) => {
      const gate = observation.replyGate;
      if (
        gate &&
        !gate.open &&
        !gate.advance &&
        isRecord(message) &&
        message.status === "ok" &&
        typeof message.taskId === "number" &&
        isRecord(message.value) &&
        message.value.type === gate.kind &&
        typeof message.value.directory === "string"
      ) {
        gate.directory = message.value.directory;
        gate.advance = () => {
          gate.advance = undefined;
          listener(message);
        };
        gate.entered.resolve();
        return;
      }
      listener(message);
    });
  };
  native.on = listen;
  return native;
}

// Delay one genuine completion; errors, exit, startup and memory traffic keep their owners.
vi.mock("./worker-native-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-native-lifecycle.js")>();
  return {
    ...actual,
    createRetainedNativeWorker(...args: Parameters<typeof actual.createRetainedNativeWorker>) {
      return observeNativeReplies(actual.createRetainedNativeWorker(...args));
    },
  };
});

function retainTaskRelease<Output>(
  task: RetainedWorkerTask<Output>,
  ordinal: number,
): RetainedWorkerTask<Output> {
  let held: RetainedOperation<void> | undefined;
  return {
    ...task,
    release(options) {
      observation.releaseContexts.set(ordinal, requestContext.getStore());
      const outcome = task.read();
      if (
        outcome.status === "fulfilled" &&
        isRecord(outcome.value) &&
        outcome.value.type === "allocated" &&
        typeof outcome.value.directory === "string"
      ) {
        observation.allocated.push(outcome.value.directory);
      }
      const gate = observation.gate;
      if (!gate || gate.ordinal !== ordinal) {
        return task.release(options);
      }
      if (held) {
        return held;
      }
      const retained = createRetainedOperation<void>(() => {
        if (gate.open) {
          retained.resolve(undefined);
        }
      });
      held = flatMapRetainedOperation(retained.operation, () => task.release(options));
      gate.advance = () => held?.service();
      gate.entered.resolve();
      held.service();
      return held;
    },
  };
}

// Keep real admission, worker replies and native tokens; hold only the caller's release.
vi.mock("./worker-task-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker-task-pool.js")>();
  return {
    ...actual,
    createOwnedWorkerTaskPool<Input, Output>(
      options: WorkerTaskPoolOptions<Output>,
      ownerOptions?: WorkerTaskPoolOwnerOptions,
    ) {
      const pool = actual.createOwnedWorkerTaskPool<Input, Output>(options, ownerOptions);
      observation.snapshots.add(pool.getSnapshot);
      return {
        ...pool,
        startTask(
          input: Parameters<typeof pool.startTask>[0],
          taskOptions: Parameters<typeof pool.startTask>[1],
        ) {
          const ordinal = ++observation.tasks;
          const task = pool.startTask(input, {
            ...taskOptions,
            transferList(prepared) {
              observation.admitted.push(prepared);
              return taskOptions.transferList?.(prepared) ?? [];
            },
          });
          observation.taskReads.set(ordinal, () => task.read());
          return retainTaskRelease(task, ordinal);
        },
      };
    },
  };
});

function holdRelease(ordinal: number): ReleaseGate {
  const gate = { ordinal, entered: createDeferredCore(), open: false };
  observation.gate = gate;
  return gate;
}

function releaseGate(gate: Gate | undefined): void {
  if (gate) {
    gate.open = true;
    gate.advance?.();
  }
}

function holdReply(kind: ReplyGate["kind"]): ReplyGate {
  return (observation.replyGate = { kind, entered: createDeferredCore(), open: false });
}

const disposals: Array<() => Promise<unknown>> = [];
const cancellations: Array<() => void> = [];
async function disposeRequests() {
  for (const cancel of cancellations.splice(0)) {
    cancel();
  }
  for (const dispose of disposals.splice(0).toReversed()) {
    await dispose();
  }
}

function allocate(root: string, signal?: AbortSignal) {
  const pending = createSqliteSnapshotStagingDirectory(root, false, signal, true);
  disposals.push(async () => {
    const [result] = await Promise.allSettled([pending]);
    if (result.status === "fulfilled") {
      expect(await removeTempDirectoryAsync(result.value)).toBe(true);
    }
  });
  return pending;
}

function startPreparation(root: string, pathname: string, signal?: AbortSignal) {
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const request = captureSqliteSnapshotStagingOwner().start(
    {
      type: "prepare",
      root,
      pathname,
      allowLegacyWorker: false,
      preserveSourceArtifacts: true,
      deadlineOwnedByCaller: false,
      launch: { env, cwd, transport: { kind: "native" } },
    },
    signal,
  );
  disposals.push(async () => {
    await Promise.allSettled([request.result]);
    await request.startClose().result;
  });
  return request;
}

beforeEach(() => {
  observation.tasks = 0;
  observation.admitted = [];
  observation.allocated = [];
  observation.gate = undefined;
  observation.replyGate = undefined;
  observation.taskReads.clear();
  observation.releaseContexts.clear();
});

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    releaseGate(observation.replyGate);
    releaseGate(observation.gate);
    await disposeRequests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await cleanupSnapshotOperations();
    for (const snapshot of observation.snapshots) {
      expect(snapshot()).toMatchObject({ workers: 0, activeTasks: 0, pendingTasks: 0 });
    }
    cleanup();
  });
});

function createProbe(root: string, name = "source", value = "preserved") {
  const filename = path.join(root, `${name}.sqlite`);
  using database = new (requireNodeSqlite().DatabaseSync)(filename);
  database.exec("CREATE TABLE probe(value TEXT)");
  database.prepare("INSERT INTO probe VALUES(?)").run(value);
  return filename;
}

function fixture(cache = false) {
  const root = directories.make("staging-owner-");
  if (cache) {
    const directory = path.join(root, "cache");
    fs.mkdirSync(directory);
    vi.stubEnv("XDG_CACHE_HOME", directory);
  }
  const controller = new AbortController();
  const reason = new Error("snapshot caller canceled");
  const abort = () => controller.abort(reason);
  cancellations.push(abort);
  return { root, signal: controller.signal, reason, abort };
}

function expectEntries(root: string, ...filenames: string[]) {
  expect(fs.readdirSync(root).toSorted()).toEqual(
    filenames.map((name) => path.basename(name)).toSorted(),
  );
}

function expectSiblingAlive(sentinel: string) {
  expect(fs.readFileSync(sentinel, "utf8")).toBe("sibling snapshot bytes");
  expect([...observation.snapshots].some((snapshot) => snapshot().workers === 1)).toBe(true);
}

it.each(["pre-aborted", "queued", "accepted"] as const)(
  "sends preparation cancellation only after dispatch (%s)",
  async (phase) => {
    const { root, signal, reason, abort } = fixture();
    const pathname = createProbe(root);
    const gate = phase === "queued" ? holdRelease(1) : undefined;
    const first = gate ? allocate(root) : undefined;
    // oxlint-disable-next-line typescript/unbound-method -- call keeps the real MessagePort receiver.
    const nativePost = MessagePort.prototype.postMessage;
    const posts = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
      transfers,
    ) {
      nativePost.call(this, message, transfers);
      if (
        phase === "accepted" &&
        isRecord(message) &&
        isRecord(message.input) &&
        message.input.type === "prepare" &&
        message.input.abortPort instanceof MessagePort
      ) {
        abort();
      }
    });
    if (gate && first) {
      await waitForGate(gate, first);
    }
    if (phase === "pre-aborted") {
      abort();
    }
    const request = startPreparation(root, pathname, signal);
    const rejected =
      phase === "accepted"
        ? expect(request.result).rejects.toThrow("SQLite snapshot preparation stopped")
        : expect(request.result).rejects.toBe(reason);
    if (phase === "queued") {
      expect(observation.admitted).toHaveLength(1);
      abort();
    }
    releaseGate(gate);
    await rejected;
    expect(
      posts.mock.calls.filter(([message]) => isRecord(message) && message.type === "abort"),
    ).toHaveLength(phase === "accepted" ? 1 : 0);
    expect(
      observation.admitted.filter((input) => isRecord(input) && input.type === "prepare"),
    ).toHaveLength(phase === "accepted" ? 1 : 0);
    await disposeRequests();
    expectEntries(root, pathname);
  },
);

it.each(["queued", "accepted"] as const)(
  "settles %s allocation cancellation without retiring a sibling token",
  async (phase) => {
    const { root, signal, reason, abort } = fixture();
    const gate = phase === "queued" ? holdRelease(1) : undefined;
    let replyGate: ReplyGate | undefined;
    const first = allocate(root);
    if (gate) {
      await waitForGate(gate, first);
    } else {
      await first;
      replyGate = holdReply("allocated");
    }
    const second = allocate(root, signal);
    const rejected = expect(second).rejects.toBe(reason);
    if (replyGate) {
      await waitForGate(replyGate, second);
    } else {
      await nextTurn();
    }
    expect(observation.tasks).toBe(2);
    expect(observation.admitted).toHaveLength(phase === "queued" ? 1 : 2);
    expect(observation.allocated).toHaveLength(1);
    if (replyGate) {
      expect(observation.taskReads.get(2)?.()).toEqual({ status: "pending" });
      expect(replyGate.directory).toBeDefined();
      expect(fs.existsSync(replyGate.directory!)).toBe(true);
      expectEntries(root, observation.allocated[0]!, replyGate.directory!);
    }
    const sibling = observation.allocated[0]!;
    const sentinel = path.join(sibling, "retained.txt");
    fs.writeFileSync(sentinel, "sibling snapshot bytes");
    abort();
    await nextTurn();
    if (replyGate) {
      expect(observation.taskReads.get(2)?.()).toEqual({ status: "pending" });
    }
    expectSiblingAlive(sentinel);
    releaseGate(gate);
    releaseGate(replyGate);
    expect(await first).toBe(sibling);
    await rejected;
    expect(observation.admitted).toHaveLength(phase === "queued" ? 1 : 2);
    expect(observation.allocated).toHaveLength(phase === "queued" ? 1 : 2);
    expectSiblingAlive(sentinel);
    expectEntries(root, sibling);
    await disposeRequests();
    expectEntries(root);
  },
);

it("preserves allocation launch facts while waiting behind another token command", async () => {
  const { root } = fixture();
  const changedCwd = path.join(root, "changed-cwd");
  fs.mkdirSync(changedCwd);
  const originalCwd = process.cwd();
  const cwd = vi.spyOn(process, "cwd");
  vi.stubEnv("OPENCLAW_SNAPSHOT_HOST_CAPTURE_FIXTURE", "captured");
  const gate = holdRelease(1);
  const allocations = [allocateWorkerOwnedSqliteSnapshotDirectory(root, false)];
  try {
    await waitForGate(gate, allocations[0]!);
    allocations.push(allocateWorkerOwnedSqliteSnapshotDirectory(root, false));
    expect(observation.tasks).toBe(2);
    expect(observation.admitted).toHaveLength(1);
    cwd.mockReturnValue(changedCwd);
    vi.stubEnv("OPENCLAW_SNAPSHOT_HOST_CAPTURE_FIXTURE", "changed-while-queued");
    releaseGate(gate);
    const owned = await Promise.all(allocations);
    expect(observation.admitted).toHaveLength(2);
    for (const command of observation.admitted) {
      expect(command).toMatchObject({
        type: "allocate",
        launch: {
          cwd: originalCwd,
          env: { OPENCLAW_SNAPSHOT_HOST_CAPTURE_FIXTURE: "captured" },
        },
      });
    }
    expect(owned.every(({ directory }) => fs.existsSync(directory))).toBe(true);
  } finally {
    cwd.mockRestore();
    vi.unstubAllEnvs();
    releaseGate(gate);
    for (const result of await Promise.allSettled(allocations)) {
      if (result.status === "fulfilled") {
        await result.value.startRetire().result;
      }
    }
  }
  expectEntries(root, "changed-cwd");
});

it("retains independent snapshot owners across scoped Doctor state environments", async () => {
  const { root } = fixture();
  const owned: Awaited<ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory>>[] = [];
  try {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "report-state"));
    const report = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    owned.push(report);
    const reportBytes = path.join(report.directory, "retained.txt");
    fs.writeFileSync(reportBytes, "report snapshot");

    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "inspection-state"));
    const inspection = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    owned.push(inspection);
    const inspectionBytes = path.join(inspection.directory, "retained.txt");
    fs.writeFileSync(inspectionBytes, "inspection snapshot");
    expect(fs.readFileSync(reportBytes, "utf8")).toBe("report snapshot");

    await report.startRetire().result;
    expect(fs.existsSync(report.directory)).toBe(false);
    expect(fs.readFileSync(inspectionBytes, "utf8")).toBe("inspection snapshot");
    await inspection.startRetire().result;
    expectEntries(root);
  } finally {
    for (const snapshot of owned) {
      await snapshot.startRetire().result;
    }
  }
});

it("services a queued snapshot while the earlier caller's Promise reactions are blocked", async () => {
  const { root } = fixture(true);
  const sqlite = requireNodeSqlite();
  const sources = ["first", "second"].map((value) => createProbe(root, value, value));
  const original = sources.map((filename) => fs.readFileSync(filename));
  const replyGate = holdReply("prepared");
  const first = requestContext.run("first", () =>
    startSqliteReadOnlyLocationAsync(sources[0]!, { preserveSourceArtifacts: true }),
  );
  let firstCallbackRan = false;
  const markFirstCallback = () => {
    firstCallbackRan = true;
  };
  void first.result.then(markFirstCallback, markFirstCallback);
  const requests = [first];
  try {
    await waitForGate(replyGate, first.result);
    expect(observation.taskReads.get(1)?.()).toEqual({ status: "pending" });
    const second = requestContext.run("second", () =>
      startSqliteReadOnlyLocationAsync(sources[1]!, { preserveSourceArtifacts: true }),
    );
    requests.push(second);
    second.service();
    expect(observation.tasks).toBe(2);
    expect(observation.admitted).toHaveLength(1);
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    const originalConstructor = sqlite.DatabaseSync;
    let nativeConstructions = 0;
    sqlite.DatabaseSync = new Proxy(originalConstructor, {
      construct() {
        nativeConstructions++;
        throw new Error("Snapshot servicing constructed SQLite in the caller realm");
      },
    });
    syncBuiltinESMExports();
    let outcome: RetainedOutcome<RetainedPreparedSqliteReadOnlyLocation>;
    try {
      releaseGate(replyGate);
      expect(observation.taskReads.get(1)?.().status).toBe("fulfilled");
      const barrier = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 10_000;
      outcome = second.read();
      while (outcome.status === "pending" && performance.now() < deadline) {
        second.service();
        outcome = second.read();
        if (outcome.status === "pending") {
          Atomics.wait(barrier, 0, 0, 2);
        }
      }
    } finally {
      sqlite.DatabaseSync = originalConstructor;
      syncBuiltinESMExports();
    }
    expect([microtaskRan, firstCallbackRan, nativeConstructions]).toEqual([false, false, 0]);
    if (outcome.status !== "fulfilled") {
      throw new Error("Queued snapshot did not progress without the earlier caller's reactions", {
        cause: outcome.status === "rejected" ? outcome.error : undefined,
      });
    }
    expect(observation.releaseContexts.get(1)).toBe("first");
    expect(observation.releaseContexts.get(2)).toBe("second");
    {
      using reader = new sqlite.DatabaseSync(outcome.value.location, { readOnly: true });
      expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "second" });
    }
    expect(sources.map((filename) => fs.readFileSync(filename))).toEqual(original);
  } finally {
    releaseGate(replyGate);
    // Yield only after the blocked-host assertions; both accepted owners must then settle.
    const outcomes = await Promise.allSettled(requests.map((request) => request.result));
    const closed = await Promise.allSettled(requests.map((request) => request.startClose().result));
    for (const closure of closed) {
      expect(closure).toMatchObject({ status: "fulfilled", value: undefined });
    }
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled" && outcome.value) {
        expect(fs.existsSync(outcome.value.location)).toBe(false);
      }
    }
  }
});

it("preserves the cleanup cause while a snapshot still has an active reader", async () => {
  const { root } = fixture();
  const request = startPreparation(root, createProbe(root));
  const reply = await request.result;
  const releaseReader = retainSnapshotTempDirectory(reply.directory);
  try {
    await expect(request.startClose().result).rejects.toMatchObject({
      message: `SQLite staging preparation cleanup failed: ${reply.directory}`,
      cause: expect.objectContaining({
        message: "SQLite snapshot still belongs to an active reader",
      }),
    });
    expect(fs.existsSync(reply.directory)).toBe(true);
  } finally {
    releaseReader();
  }
  await request.startClose().result;
  expect(fs.existsSync(reply.directory)).toBe(false);
});

it("retains an early preparation close until its original accepted result joins", async () => {
  const { root } = fixture();
  const source = createProbe(root, "source", "early");
  const gate = holdReply("prepared");
  const request = startPreparation(root, source);
  await waitForGate(gate, request.result);
  const closing = request.startClose();
  expect([request.read().status, closing.read().status]).toEqual(["pending", "pending"]);
  expect(fs.existsSync(gate.directory!)).toBe(true);
  releaseGate(gate);
  const reply = await request.result;
  expect(reply.type).toBe("prepared");
  await closing.result;
  expect(fs.existsSync(reply.directory)).toBe(false);
  expect(request.read()).toEqual({ status: "fulfilled", value: reply });
  await expect(request.startClose().result).resolves.toBeUndefined();
  await disposeRequests();
});

it("keeps an unbound snapshot reader alive across retained generation close and subsequent admission", async () => {
  const { root, signal, abort } = fixture(true);
  const source = createProbe(root);
  const original = fs.readFileSync(source);
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging");
  const released = new Set<string>();
  const inGeneration = (name: string, run: () => Promise<void>) => {
    return withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) => {
          if (url.href !== stagingUrl.href) {
            return url;
          }
          const retained = new URL(url);
          retained.searchParams.set("snapshot-test-generation", name);
          return retained;
        });
        await run();
      },
      async () => {
        released.add(name);
      },
    );
  };
  const readProbe = (location: string) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from 'node:sqlite';
         const database = new DatabaseSync(process.argv[1], { readOnly: true });
         try { process.stdout.write(JSON.stringify(database.prepare('SELECT value FROM probe').get())); }
         finally { database.close(); }`,
        location,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const unbound = AsyncLocalStorage.snapshot();
  const options = { preserveSourceArtifacts: true, signal };
  const gate = holdRelease(1);
  const firstReady = createDeferredCore<RetainedPreparedSqliteReadOnlyLocation>();
  const finishFirst = createDeferredCore();
  const firstGeneration = inGeneration("first", async () => {
    try {
      const prepared = await startSqliteReadOnlyLocationAsync(source, options).result;
      firstReady.resolve(prepared);
      await finishFirst.promise;
      expect(await prepared.cleanupAsync()).toBe(true);
    } catch (error) {
      firstReady.reject(error);
      throw error;
    }
  });
  const firstSettled = firstGeneration.then(
    () => true,
    () => false,
  );
  let second: ReturnType<typeof startSqliteReadOnlyLocationAsync> | undefined;
  let releaseReader: (() => void) | undefined;
  try {
    await waitForGate(gate, firstReady.promise);
    second = unbound(() => startSqliteReadOnlyLocationAsync(source, options));
    releaseGate(gate);
    const [, survivor] = await Promise.all([firstReady.promise, second.result]);
    releaseReader = retainSnapshotTempDirectory(
      survivor.cleanupRoot ?? path.dirname(survivor.location),
    );
    finishFirst.resolve();
    await expect(firstGeneration).resolves.toBeUndefined();
    expect(released.has("first")).toBe(true);
    expect(readProbe(survivor.location)).toEqual({ value: "preserved" });
    releaseReader();
    releaseReader = undefined;
    expect(await survivor.cleanupAsync()).toBe(true);
    expect(fs.existsSync(survivor.location)).toBe(false);

    await inGeneration("subsequent", async () => {
      const prepared = await startSqliteReadOnlyLocationAsync(source, options).result;
      try {
        expect(readProbe(prepared.location)).toEqual({ value: "preserved" });
      } finally {
        expect(await prepared.cleanupAsync()).toBe(true);
      }
    });
    expect(released.has("subsequent")).toBe(true);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    releaseGate(gate);
    finishFirst.resolve();
    releaseReader?.();
    abort();
    for (const result of await Promise.allSettled([firstReady.promise, second?.result])) {
      if (result.status === "fulfilled" && result.value) {
        expect(await result.value.cleanupAsync()).toBe(true);
      }
    }
    if (!(await firstSettled)) {
      // A failed generation stays retained even after its snapshot tokens later join.
      expect(released.has("first")).toBe(false);
    }
  }
});
