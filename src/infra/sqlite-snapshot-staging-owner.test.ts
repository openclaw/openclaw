import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createRetainedOperation,
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
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import { startSqliteReadOnlyLocationAsync } from "./sqlite-snapshot-source.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import { holdNativeStop, waitForGate } from "./sqlite-snapshot-staging-owner.test-support.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";
import type {
  RetainedWorkerTask,
  WorkerTaskPoolOptions,
  WorkerTaskPoolOwnerOptions,
} from "./worker-task-pool.types.js";

type ReleaseGate = {
  ordinal: number;
  entered: ReturnType<typeof createDeferredCore<void>>;
  open: boolean;
  advance?: () => void;
};
type ReplyGate = {
  kind: "allocated" | "prepared";
  entered: ReturnType<typeof createDeferredCore<void>>;
  open: boolean;
  directory?: string;
  deliver?: () => void;
};
type StopFailureGate = {
  directory: string;
  entered: ReturnType<typeof createDeferredCore<void>>;
  failure: Error;
  claimed: boolean;
  operation: RetainedOperation<void>;
  reject(): void;
};
const requestContext = new AsyncLocalStorage<string>();
const observation = {
  tasks: 0,
  admitted: [] as unknown[],
  allocated: [] as string[],
  gate: undefined as ReleaseGate | undefined,
  replyGate: undefined as ReplyGate | undefined,
  stopGate: undefined as StopFailureGate | undefined,
  taskReads: new Map<number, () => RetainedOutcome<unknown>>(),
  releaseContexts: new Map<number, string | undefined>(),
  snapshots: new Set<() => { workers: number; activeTasks: number; pendingTasks: number }>(),
  rotations: new Set<() => Promise<void>>(),
  workers: new Set<RetainedNativeWorker>(),
};

type NativeSubscription =
  | [event: "message", listener: (message: unknown) => void]
  | [event: "error" | "messageerror", listener: (error: Error) => void]
  | [event: "started", listener: () => void]
  | [event: "execution-exit", listener: (code: number | undefined) => void]
  | [event: "exit", listener: (code: number | undefined) => void];

function observeNativeReplies(native: RetainedNativeWorker): RetainedNativeWorker {
  observation.workers.add(native);
  const stop = native.stop.bind(native);
  native.stop = () => {
    const gate = observation.stopGate;
    if (!gate || gate.claimed) {
      return stop();
    }
    gate.claimed = true;
    expect(fs.existsSync(gate.directory)).toBe(false);
    expect(native.threadId).toBeGreaterThan(0);
    gate.entered.resolve();
    return gate.operation;
  };
  const on = native.on.bind(native);
  function listen(event: "message", listener: (message: unknown) => void): unknown;
  function listen(event: "error" | "messageerror", listener: (error: Error) => void): unknown;
  function listen(event: "started", listener: () => void): unknown;
  function listen(event: "execution-exit", listener: (code: number | undefined) => void): unknown;
  function listen(event: "exit", listener: (code: number | undefined) => void): unknown;
  function listen(...[event, listener]: NativeSubscription): unknown {
    if (event !== "message") {
      // EventEmitter.once also forwards its exit subscription through this method.
      return Reflect.apply(on, native, [event, listener]);
    }
    return on("message", (message) => {
      const gate = observation.replyGate;
      if (
        gate &&
        !gate.open &&
        !gate.deliver &&
        isRecord(message) &&
        message.status === "ok" &&
        typeof message.taskId === "number" &&
        isRecord(message.value) &&
        message.value.type === gate.kind &&
        typeof message.value.directory === "string"
      ) {
        gate.directory = message.value.directory;
        gate.deliver = () => listener(message);
        gate.entered.resolve();
        return;
      }
      listener(message);
    });
  }
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
      let release: RetainedOperation<void> | undefined;
      const retained = createRetainedOperation<void>(() => {
        if (!gate.open || retained.operation.read().status !== "pending") {
          return;
        }
        if (!release) {
          release = task.release(options);
          void release.result.then(
            () => retained.operation.service(),
            () => retained.operation.service(),
          );
        }
        release.service();
        const settled = release.read();
        if (settled.status === "fulfilled") {
          retained.resolve(undefined);
        } else if (settled.status === "rejected") {
          retained.reject(settled.error);
        }
      });
      held = retained.operation;
      gate.advance = () => retained.operation.service();
      gate.entered.resolve();
      retained.operation.service();
      return retained.operation;
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
      observation.rotations.add(pool.rotate);
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

function holdNextNativeStop(directory: string): StopFailureGate {
  const pending = createRetainedOperation<void>(() => {});
  const failure = new Error("native stop was not acknowledged");
  const gate = {
    directory,
    entered: createDeferredCore(),
    failure,
    claimed: false,
    operation: pending.operation,
    reject: () => pending.reject(failure),
  };
  observation.stopGate = gate;
  return gate;
}

function releaseGate(gate: ReleaseGate | undefined): void {
  if (gate) {
    gate.open = true;
    gate.advance?.();
  }
}

function releaseReplyGate(gate: ReplyGate | undefined): void {
  if (gate) {
    gate.open = true;
    const deliver = gate.deliver;
    gate.deliver = undefined;
    deliver?.();
  }
}

beforeEach(() => {
  observation.tasks = 0;
  observation.admitted = [];
  observation.allocated = [];
  observation.gate = undefined;
  observation.replyGate = undefined;
  observation.stopGate = undefined;
  observation.taskReads.clear();
  observation.releaseContexts.clear();
  observation.workers.clear();
});

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    observation.stopGate?.reject();
    releaseReplyGate(observation.replyGate);
    releaseGate(observation.gate);
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
  const database = new (requireNodeSqlite().DatabaseSync)(filename);
  try {
    database.exec("CREATE TABLE probe(value TEXT)");
    database.prepare("INSERT INTO probe VALUES(?)").run(value);
  } finally {
    database.close();
  }
  return filename;
}

it.each(["queued", "accepted"] as const)(
  "settles %s allocation cancellation without retiring a sibling token",
  async (phase) => {
    const root = directories.make("staging-cancel-custody-");
    const gate = phase === "queued" ? holdRelease(1) : undefined;
    let replyGate: ReplyGate | undefined;
    const controller = new AbortController();
    const reason = new Error("snapshot caller canceled");
    const first = createSqliteSnapshotStagingDirectory(root, false, undefined, true);
    let second: Promise<string> | undefined;
    try {
      if (gate) {
        await waitForGate(gate, first);
      } else {
        await first;
        replyGate = { kind: "allocated", entered: createDeferredCore(), open: false };
        observation.replyGate = replyGate;
      }
      second = createSqliteSnapshotStagingDirectory(root, false, controller.signal, true);
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
        expect(fs.readdirSync(root).toSorted()).toEqual(
          [observation.allocated[0]!, replyGate.directory!]
            .map((directory) => path.basename(directory))
            .toSorted(),
        );
      }
      const sibling = observation.allocated[0]!;
      const sentinel = path.join(sibling, "retained.txt");
      fs.writeFileSync(sentinel, "sibling snapshot bytes");
      controller.abort(reason);
      await nextTurn();
      if (replyGate) {
        expect(observation.taskReads.get(2)?.()).toEqual({ status: "pending" });
      }
      expect(fs.readFileSync(sentinel, "utf8")).toBe("sibling snapshot bytes");
      expect([...observation.snapshots].some((snapshot) => snapshot().workers === 1)).toBe(true);
      releaseGate(gate);
      releaseReplyGate(replyGate);
      expect(await first).toBe(sibling);
      await rejected;
      expect(observation.admitted).toHaveLength(phase === "queued" ? 1 : 2);
      expect(observation.allocated).toHaveLength(phase === "queued" ? 1 : 2);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("sibling snapshot bytes");
      expect(fs.readdirSync(root)).toEqual([path.basename(sibling)]);
      expect([...observation.snapshots].some((snapshot) => snapshot().workers === 1)).toBe(true);
    } finally {
      releaseReplyGate(replyGate);
      releaseGate(gate);
      controller.abort(reason);
      for (const result of await Promise.allSettled([first, second])) {
        if (result.status === "fulfilled" && result.value) {
          expect(await removeTempDirectoryAsync(result.value)).toBe(true);
        }
      }
    }
    expect(fs.readdirSync(root)).toEqual([]);
  },
);

it.each(["after-failure", "queued-during-stop"] as const)(
  "settles admission %s without retaining input behind failed idle rotation",
  async (phase) => {
    const root = directories.make("staging-failed-rotation-");
    const owned = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    const gate = holdNextNativeStop(owned.directory);
    const retirement = owned.startRetire().result;
    void retirement.catch(() => undefined);
    const owner = captureSqliteSnapshotStagingOwner();
    const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
    let request: ReturnType<typeof owner.start> | undefined;
    let later: Awaited<ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory>> | undefined;
    const pendingTasks = () =>
      [...observation.snapshots].reduce((total, snapshot) => total + snapshot().pendingTasks, 0);
    try {
      await waitForGate(gate, retirement);
      if (phase === "after-failure") {
        gate.reject();
        await expect(retirement).rejects.toBe(gate.failure);
      }
      request = owner.start({
        type: "allocate",
        root,
        allowLegacyWorker: false,
        launch: { env, cwd, transport: { kind: "native" } },
      });
      if (phase === "queued-during-stop") {
        expect(request.read()).toEqual({ status: "pending" });
        expect(pendingTasks()).toBe(1);
        gate.reject();
        await expect(retirement).rejects.toBe(gate.failure);
      }
      const barrier = new Int32Array(new SharedArrayBuffer(4));
      const deadline = performance.now() + 10_000;
      let outcome = request.read();
      while (outcome.status === "pending" && performance.now() < deadline) {
        request.service();
        outcome = request.read();
        if (outcome.status === "pending") {
          Atomics.wait(barrier, 0, 0, 2);
        }
      }
      if (outcome.status !== "rejected") {
        throw new Error("Snapshot admission did not refuse the failed idle rotation");
      }
      expect(outcome.error).toBeInstanceOf(SqliteSnapshotCleanupError);
      expect(outcome.error).toMatchObject({ cause: gate.failure });
      expect(pendingTasks()).toBe(0);
      expect(await removeTempDirectoryAsync(owned.directory)).toBe(true);
      later = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
      expect(fs.existsSync(later.directory)).toBe(true);
      expect(await removeTempDirectoryAsync(later.directory)).toBe(true);
    } finally {
      gate.reject();
      // Original-code RED leaves input queued: retry actual stop before awaiting that input.
      await Promise.all([...observation.rotations].map((rotate) => rotate()));
      const settled = await Promise.allSettled([retirement, request?.result]);
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
          expect(await removeTempDirectoryAsync(result.value.directory)).toBe(true);
        }
      }
      expect(await removeTempDirectoryAsync(owned.directory)).toBe(true);
      if (later) {
        expect(await removeTempDirectoryAsync(later.directory)).toBe(true);
      }
    }
    expect(fs.readdirSync(root)).toEqual([]);
  },
);

it("preserves allocation launch facts while waiting behind another token command", async () => {
  const root = directories.make("staging-captured-launch-");
  const changedCwd = path.join(root, "changed-cwd");
  fs.mkdirSync(changedCwd);
  const originalCwd = process.cwd();
  const cwd = vi.spyOn(process, "cwd");
  vi.stubEnv("OPENCLAW_SNAPSHOT_HOST_CAPTURE_FIXTURE", "captured");
  const gate = holdRelease(1);
  const first = allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
  let second: ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory> | undefined;
  try {
    await waitForGate(gate, first);
    second = allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    expect(observation.tasks).toBe(2);
    expect(observation.admitted).toHaveLength(1);
    cwd.mockReturnValue(changedCwd);
    vi.stubEnv("OPENCLAW_SNAPSHOT_HOST_CAPTURE_FIXTURE", "changed-while-queued");
    releaseGate(gate);
    const owned = await Promise.all([first, second]);
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
    for (const result of await Promise.allSettled([first, second])) {
      if (result.status === "fulfilled" && result.value) {
        await result.value.startRetire().result;
      }
    }
  }
  expect(fs.readdirSync(root)).toEqual(["changed-cwd"]);
});

it("services a queued snapshot while the earlier caller's Promise reactions are blocked", async () => {
  const root = directories.make("staging-cross-request-progress-");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const sqlite = requireNodeSqlite();
  const sources = ["first", "second"].map((value) => createProbe(root, value, value));
  const original = sources.map((filename) => fs.readFileSync(filename));
  const replyGate: ReplyGate = {
    kind: "prepared",
    entered: createDeferredCore(),
    open: false,
  };
  observation.replyGate = replyGate;
  const first = requestContext.run("first", () =>
    startSqliteReadOnlyLocationAsync(sources[0]!, { preserveSourceArtifacts: true }),
  );
  let firstCallbackRan = false;
  void first.result.then(
    () => {
      firstCallbackRan = true;
    },
    () => {
      firstCallbackRan = true;
    },
  );
  let second: ReturnType<typeof startSqliteReadOnlyLocationAsync> | undefined;
  try {
    await waitForGate(replyGate, first.result);
    expect(observation.taskReads.get(1)?.()).toEqual({ status: "pending" });
    second = requestContext.run("second", () =>
      startSqliteReadOnlyLocationAsync(sources[1]!, { preserveSourceArtifacts: true }),
    );
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
      releaseReplyGate(replyGate);
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
    expect(microtaskRan).toBe(false);
    expect(firstCallbackRan).toBe(false);
    expect(nativeConstructions).toBe(0);
    if (outcome.status !== "fulfilled") {
      throw new Error("Queued snapshot did not progress without the earlier caller's reactions", {
        cause: outcome.status === "rejected" ? outcome.error : undefined,
      });
    }
    expect(observation.releaseContexts.get(1)).toBe("first");
    expect(observation.releaseContexts.get(2)).toBe("second");
    const reader = new sqlite.DatabaseSync(outcome.value.location, { readOnly: true });
    try {
      expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "second" });
    } finally {
      reader.close();
    }
    expect(sources.map((filename) => fs.readFileSync(filename))).toEqual(original);
  } finally {
    releaseReplyGate(replyGate);
    // Yield only after the blocked-host assertions; both accepted owners must then settle.
    const outcomes = await Promise.allSettled([first.result, ...(second ? [second.result] : [])]);
    const closed = await Promise.allSettled([
      first.startClose().result,
      ...(second ? [second.startClose().result] : []),
    ]);
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

it("retains an early preparation close until its original accepted result joins", async () => {
  const root = directories.make("staging-request-early-close-");
  const source = createProbe(root, "source", "early");
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const gate: ReplyGate = { kind: "prepared", entered: createDeferredCore(), open: false };
  observation.replyGate = gate;
  const request = captureSqliteSnapshotStagingOwner().start({
    type: "prepare",
    root,
    pathname: source,
    allowLegacyWorker: false,
    preserveSourceArtifacts: true,
    deadlineOwnedByCaller: false,
    launch: { env, cwd, transport: { kind: "native" } },
  });
  try {
    await waitForGate(gate, request.result);
    const closing = request.startClose();
    expect(request.read().status).toBe("pending");
    expect(closing.read().status).toBe("pending");
    expect(fs.existsSync(gate.directory!)).toBe(true);
    releaseReplyGate(gate);
    const reply = await request.result;
    expect(reply.type).toBe("prepared");
    await closing.result;
    expect(fs.existsSync(reply.directory)).toBe(false);
    expect(request.read()).toEqual({ status: "fulfilled", value: reply });
    await expect(request.startClose().result).resolves.toBeUndefined();
  } finally {
    releaseReplyGate(gate);
    await Promise.allSettled([request.result]);
    await request.startClose().result;
  }
});

it("keeps failed preparation custody retryable without requesting a sibling snapshot's cleanup", async () => {
  const root = directories.make("staging-request-failed-close-");
  const sqlite = requireNodeSqlite();
  const sources = ["first", "sibling"].map((value) => createProbe(root, value, value));
  const original = sources.map((filename) => fs.readFileSync(filename));
  const owner = captureSqliteSnapshotStagingOwner();
  const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
  const start = (pathname: string) =>
    owner.start({
      type: "prepare",
      root,
      pathname,
      allowLegacyWorker: false,
      preserveSourceArtifacts: true,
      deadlineOwnedByCaller: false,
      launch: { env, cwd, transport: { kind: "native" } },
    });
  const sibling = start(sources[1]!);
  const siblingReply = await sibling.result;
  if (siblingReply.type !== "prepared") {
    throw new Error("Sibling snapshot was not prepared");
  }
  const gate: ReplyGate = { kind: "prepared", entered: createDeferredCore(), open: false };
  observation.replyGate = gate;
  const first = start(sources[0]!);
  const firstOutcome = first.result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let releaseReader: (() => void) | undefined;
  let native: RetainedNativeWorker | undefined;
  let recoveryStop: ReturnType<typeof holdNativeStop> | undefined;
  try {
    await waitForGate(gate, first.result);
    if (!gate.directory) {
      throw new Error("First preparation directory was not observed");
    }
    releaseReader = retainSnapshotTempDirectory(gate.directory);
    native = [...observation.workers].find((worker) => !worker.executionStopped);
    if (!native) {
      throw new Error("Original staging Worker was not observed");
    }
    await expect(native.stop().result).rejects.toThrow("host cleanup admission failed");
    await firstOutcome;
    const failed = first.read();
    expect(failed.status).toBe("rejected");
    await expect(first.startClose().result).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: "SQLite snapshot still belongs to an active reader" }),
      ]),
    });
    expect(fs.existsSync(gate.directory)).toBe(true);
    expect(fs.existsSync(siblingReply.directory)).toBe(true);
    // The first request's close must not even seal the sibling's reader admission.
    const releaseSibling = retainSnapshotTempDirectory(siblingReply.directory);
    const reader = new sqlite.DatabaseSync(siblingReply.location, { readOnly: true });
    try {
      expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "sibling" });
    } finally {
      reader.close();
      releaseSibling();
    }
    releaseReader();
    releaseReader = undefined;
    // Native cleanup fences every sibling after VM loss. Admit both requests before
    // starting the shared stop, then prove sibling servicing alone can finish it.
    recoveryStop = holdNativeStop(native);
    const firstClose = first.startClose();
    const siblingClose = sibling.startClose();
    expect(firstClose.read().status).toBe("pending");
    expect(siblingClose.read().status).toBe("pending");
    recoveryStop.release();
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 10_000;
    while (
      (firstClose.read().status === "pending" || siblingClose.read().status === "pending") &&
      performance.now() < deadline
    ) {
      // Only B is serviced: A's failed result must not hide its still-owned close work.
      siblingClose.service();
      if (firstClose.read().status !== "pending" && siblingClose.read().status !== "pending") {
        break;
      }
      Atomics.wait(wait, 0, 0, 2);
    }
    expect(microtaskRan).toBe(false);
    expect(firstClose.read()).toEqual({ status: "fulfilled", value: undefined });
    expect(siblingClose.read()).toEqual({ status: "fulfilled", value: undefined });
    await Promise.all([firstClose.result, siblingClose.result]);
    expect(fs.existsSync(gate.directory)).toBe(false);
    expect(fs.existsSync(siblingReply.directory)).toBe(false);
    expect(first.read()).toEqual(failed);
    expect(sources.map((filename) => fs.readFileSync(filename))).toEqual(original);
  } finally {
    releaseReader?.();
    releaseReplyGate(gate);
    await Promise.allSettled([first.result, sibling.result]);
    recoveryStop?.restore();
    // Preserve the failing result while explicitly retrying canonical custody cleanup on RED.
    await Promise.allSettled([first.startClose().result, sibling.startClose().result]);
    await Promise.all([first.startClose().result, sibling.startClose().result]);
    if (native) {
      await native.stop().result;
    }
  }
});

it("keeps an owned snapshot and its creator lock after abrupt worker exit until requested cleanup joins", async () => {
  const root = directories.make("staging-lost-worker-custody-");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const sqlite = requireNodeSqlite();
  const source = createProbe(root);
  const prepared = await startSqliteReadOnlyLocationAsync(source, {
    preserveSourceArtifacts: true,
  }).result;
  const directory = prepared.cleanupRoot ?? path.dirname(prepared.location);
  let releaseReader: (() => void) | undefined;
  let next: RetainedPreparedSqliteReadOnlyLocation | undefined;
  try {
    const native = [...observation.workers].find((worker) => !worker.executionStopped);
    expect(native).toBeDefined();
    if (!native) {
      throw new Error("Snapshot worker was not observed");
    }
    // Terminate the disposable VM without running its logical directory finalizer.
    await expect(native.stop().result).rejects.toThrow("cleanup has not been requested");
    expect(native.executionStopped).toBe(true);
    expect(fs.existsSync(prepared.location)).toBe(true);
    const token = new sqlite.DatabaseSync(path.join(directory, "owner.sqlite"), { timeout: 0 });
    try {
      expect(() => token.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
    } finally {
      if (token.isTransaction) {
        token.exec("ROLLBACK");
      }
      token.close();
    }
    releaseReader = retainSnapshotTempDirectory(directory);
    const reader = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
    try {
      expect(reader.prepare("SELECT value FROM probe").get()).toMatchObject({ value: "preserved" });
    } finally {
      reader.close();
    }
    expect(await prepared.cleanupAsync()).toBe(false);
    expect(fs.existsSync(prepared.location)).toBe(true);
    releaseReader();
    releaseReader = undefined;
    expect(await prepared.cleanupAsync()).toBe(true);
    expect(fs.existsSync(directory)).toBe(false);
    next = await startSqliteReadOnlyLocationAsync(source, { preserveSourceArtifacts: true }).result;
    expect(await next.cleanupAsync()).toBe(true);
    next = undefined;
  } finally {
    releaseReader?.();
    expect(await prepared.cleanupAsync()).toBe(true);
    if (next) {
      expect(await next.cleanupAsync()).toBe(true);
    }
  }
});

it("joins both generation snapshots after their shared staging Worker exits abruptly", async () => {
  const root = directories.make("staging-generation-lost-siblings-");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const sqlite = requireNodeSqlite();
  const sources = ["first", "second"].map((value) => createProbe(root, value, value));
  const original = sources.map((filename) => fs.readFileSync(filename));
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging");
  const prepared: RetainedPreparedSqliteReadOnlyLocation[] = [];
  let originalNative: RetainedNativeWorker | undefined;
  let codeReleased = false;
  const generation = withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        if (url.href !== stagingUrl.href) {
          return url;
        }
        const retained = new URL(url);
        retained.searchParams.set("snapshot-test-generation", "lost-sibling-roots");
        return retained;
      });
      for (const [index, source] of sources.entries()) {
        const snapshot = await startSqliteReadOnlyLocationAsync(source, {
          preserveSourceArtifacts: true,
        }).result;
        prepared.push(snapshot);
        const reader = new sqlite.DatabaseSync(snapshot.location, { readOnly: true });
        try {
          expect(reader.prepare("SELECT value FROM probe").get()).toEqual({
            value: index === 0 ? "first" : "second",
          });
        } finally {
          reader.close();
        }
      }
      expect(new Set(prepared.map((snapshot) => snapshot.cleanupRoot)).size).toBe(2);
      const workers = [...observation.workers];
      expect(workers).toHaveLength(1);
      originalNative = workers[0];
      if (!originalNative) {
        throw new Error("Generation staging Worker was not observed");
      }
      // Stop the original VM without running either logical directory finalizer.
      await expect(originalNative.stop().result).rejects.toThrow("host cleanup admission failed");
      expect(originalNative.executionStopped).toBe(true);
      expect(prepared.every((snapshot) => fs.existsSync(snapshot.location))).toBe(true);
      // Generation retirement must request both roots before their shared native owner closes.
    },
    async () => {
      expect(prepared).toHaveLength(2);
      for (const snapshot of prepared) {
        expect(fs.existsSync(snapshot.cleanupRoot ?? path.dirname(snapshot.location))).toBe(false);
      }
      codeReleased = true;
    },
  );
  const settled = generation.then(
    () => ({ released: true }),
    (error: unknown) => ({ error }),
  );
  try {
    await expect(generation).resolves.toBeUndefined();
    expect(codeReleased).toBe(true);
    expect(sources.map((filename) => fs.readFileSync(filename))).toEqual(original);
  } finally {
    // A causal failure can retain the generation while later explicit cleanup joins native custody.
    const cleanups = await Promise.allSettled(prepared.map((snapshot) => snapshot.cleanupAsync()));
    for (const cleanup of cleanups) {
      expect(cleanup).toEqual({ status: "fulfilled", value: true });
    }
    if (originalNative) {
      await originalNative.stop().result;
    }
    const outcome = await settled;
    if ("error" in outcome) {
      expect(codeReleased).toBe(false);
    }
  }
});

it("keeps an unbound snapshot reader alive across retained generation close and subsequent admission", async () => {
  const root = directories.make("staging-generation-reader-");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  vi.stubEnv("XDG_CACHE_HOME", cache);
  const source = createProbe(root);
  const original = fs.readFileSync(source);
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging");
  const resolveGeneration = (name: string) => (url: URL) => {
    if (url.href !== stagingUrl.href) {
      return url;
    }
    const retained = new URL(url);
    retained.searchParams.set("snapshot-test-generation", name);
    return retained;
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
  const controller = new AbortController();
  const options = { preserveSourceArtifacts: true, signal: controller.signal };
  const gate = holdRelease(1);
  const firstReady = createDeferredCore<RetainedPreparedSqliteReadOnlyLocation>();
  const finishFirst = createDeferredCore();
  let firstReleased = false;
  const firstGeneration = withRuntimeWorkerGeneration(
    async (bind) => {
      try {
        bind(resolveGeneration("first"));
        const prepared = await startSqliteReadOnlyLocationAsync(source, options).result;
        firstReady.resolve(prepared);
        await finishFirst.promise;
        expect(await prepared.cleanupAsync()).toBe(true);
      } catch (error) {
        firstReady.reject(error);
        throw error;
      }
    },
    async () => {
      firstReleased = true;
    },
  );
  const firstSettled = firstGeneration.then(
    () => ({ released: true }),
    (error: unknown) => ({ error }),
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
    expect(firstReleased).toBe(true);
    expect(readProbe(survivor.location)).toEqual({ value: "preserved" });
    releaseReader();
    releaseReader = undefined;
    expect(await survivor.cleanupAsync()).toBe(true);
    expect(fs.existsSync(survivor.location)).toBe(false);

    let subsequentReleased = false;
    await withRuntimeWorkerGeneration(
      async (bind) => {
        bind(resolveGeneration("subsequent"));
        const prepared = await startSqliteReadOnlyLocationAsync(source, options).result;
        try {
          expect(readProbe(prepared.location)).toEqual({ value: "preserved" });
        } finally {
          expect(await prepared.cleanupAsync()).toBe(true);
        }
      },
      async () => {
        subsequentReleased = true;
      },
    );
    expect(subsequentReleased).toBe(true);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    releaseGate(gate);
    finishFirst.resolve();
    releaseReader?.();
    controller.abort(new Error("Snapshot generation fixture stopped"));
    for (const result of await Promise.allSettled([firstReady.promise, second?.result])) {
      if (result.status === "fulfilled" && result.value) {
        expect(await result.value.cleanupAsync()).toBe(true);
      }
    }
    const generation = await firstSettled;
    if ("error" in generation) {
      // A failed generation stays retained even after its snapshot tokens later join.
      expect(firstReleased).toBe(false);
    }
  }
});
