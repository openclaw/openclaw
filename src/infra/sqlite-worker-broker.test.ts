import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs, { existsSync } from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as retry from "@openclaw/retry";
import { expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as logging from "../logging/logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { createSqliteFamilyEngines } from "./database-engine/selection-fixture.test-support.js";
import { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } from "./diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import * as stateOwner from "./gateway-state-owner.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import {
  reserveSqliteWorkerInputPreparation,
  runSqliteWorkerStoreOperation,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import * as workerCpu from "./worker-cpu.js";

vi.mock("./diagnostic-flags.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diagnostic-flags.js")>()),
  isDiagnosticFlagEnabled: () => false,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { databasePath, open } = useSqliteWorkerStoreFixture("sqlite-worker-broker-", () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;
const queueRows = Array.from({ length: 128 }, (_, index) => String(index));
const rejectedOutcome = (reason: unknown) => ({ status: "rejected", reason });

it.each([false, true])(
  "dispatches captured SQLite selection without an engine scope (different ambient: %s)",
  async (differentAmbient) => {
    const file = databasePath();
    const store = await open(file);
    const selected = { effectiveEngines: createSqliteFamilyEngines() };
    const ambient = differentAmbient
      ? {
          effectiveEngines: createSqliteFamilyEngines({ state: "postgres" }),
          postgres: { connection: "postgresql://localhost/synthetic", schemaPrefix: "test" },
        }
      : selected;
    await withDatabaseEngineSelection(ambient, async () => {
      const enterContext = vi.spyOn(AsyncLocalStorage.prototype, "run");
      try {
        await runSqliteWorkerStoreOperation(
          store,
          async (scope) => {
            await scope.execute({ type: "append", input: { value: "captured SQLite selection" } });
            expect(await scope.execute({ type: "read", input: undefined })).toEqual([
              "captured SQLite selection",
            ]);
          },
          { databaseEngineSelection: selected, environment: { OPENCLAW_STATE_DIR: file } },
        );
        expect(enterContext.mock.calls.filter(([value]) => value === selected)).toHaveLength(0);
      } finally {
        enterContext.mockRestore();
      }
    });
  },
);

it("retires a disk-full nested transaction without claiming a definite write outcome", async () => {
  const file = databasePath();
  const store = await open(file, { type: "disk-full" });
  const outcomes = await Promise.allSettled([append(store, "full"), append(store, "queued")]);
  expect(outcomes).toMatchObject([
    rejectedOutcome({ code: "outcome-unknown" }),
    rejectedOutcome({ code: "unavailable" }),
  ]);
  for (const outcome of outcomes) {
    assert(outcome.status === "rejected");
    expect(collectNestedErrorCandidates(outcome.reason)).toEqual(
      expect.arrayContaining([expect.objectContaining({ errcode: 13 })]),
    );
  }
  const recovered = await open(file);
  expect(await read(recovered)).toEqual([]);
  await append(recovered, "recovered");
  expect(await read(recovered)).toEqual(["recovered"]);
});

it.for(["resume", "replace", "replace-inode", "symlink", "release"] as const)(
  "keeps dispatch responsive to slow physical owner checks and refuses %s custody changes",
  async (ending, { signal, skip }) => {
    if (ending === "symlink" && process.platform === "win32") {
      skip(); // File symlinks require privileges on Windows.
    }
    const pause = new Int32Array(new SharedArrayBuffer(8));
    const blocked = createDeferredCore();
    const createWorker = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) => {
      const data: unknown = options?.workerData;
      if (!isRecord(data) || !(data.lastBeat instanceof SharedArrayBuffer)) {
        return createWorker(url, options);
      }
      const worker = createWorker(
        new URL(
          `data:text/javascript,${encodeURIComponent(`
          import fs from "node:fs";
          import { parentPort, workerData } from "node:worker_threads";
          const pause = new Int32Array(workerData.verificationPause);
          const lstat = fs.lstatSync;
          fs.lstatSync = (...args) => {
            if (Atomics.compareExchange(pause, 0, 1, 2) === 1) {
              parentPort.postMessage("verification-blocked");
              Atomics.wait(pause, 1, 0);
            }
            return lstat(...args);
          };
          await import(${JSON.stringify(String(url))});
        `)}`,
        ),
        { ...options, workerData: { ...data, verificationPause: pause.buffer } },
      );
      worker.on("message", (message) => {
        if (message === "verification-blocked") {
          blocked.resolve();
        }
      });
      return worker;
    });
    const file = databasePath();
    const owner = stateOwner.acquireGatewayStateOwner({
      databasePath: file,
      payload: {
        pid: process.pid,
        role: "gateway",
        createdAt: new Date().toISOString(),
        configPath: `${file}.config`,
        processNamespace: readGatewayLockProcessNamespace(),
      },
    });
    const store = await open(file);
    const original = fs.readFileSync(owner.path);
    const moved = `${owner.path}.original`;
    let movedOriginal = false;
    let released = false;
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const lstat = fs.lstatSync;
    let hostOwnerReads = 0;
    const hostProbe = vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
      if (String(pathname) === owner.path) {
        hostOwnerReads++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      return lstat(pathname, options);
    });
    try {
      Atomics.store(pause, 0, 1);
      let settled = false;
      pending = Promise.allSettled([append(store, "accepted")]).then((result) => {
        settled = true;
        return result;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(hostOwnerReads).toBe(0);
      await withinTest(blocked.promise, signal);
      // The real heartbeat worker is blocked inside fs; the host remains responsive.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).toBe(false);
      hostProbe.mockRestore();
      if (ending === "replace") {
        fs.writeFileSync(owner.path, "replacement");
      } else if (ending === "replace-inode" || ending === "symlink") {
        fs.renameSync(owner.path, moved);
        movedOriginal = true;
        if (ending === "replace-inode") {
          fs.copyFileSync(moved, owner.path);
        } else {
          fs.symlinkSync(moved, owner.path);
        }
      } else if (ending === "release") {
        owner.release();
        released = true;
      }
      Atomics.store(pause, 1, 1);
      Atomics.notify(pause, 1);
      const outcomes = await withinTest(pending, signal);
      if (ending === "resume") {
        expect(outcomes).toMatchObject([{ status: "fulfilled" }]);
        expect(await read(store)).toEqual(["accepted"]);
      } else {
        expect(outcomes).toMatchObject([{ status: "rejected" }]);
      }
    } finally {
      hostProbe.mockRestore();
      Atomics.store(pause, 1, 1);
      Atomics.notify(pause, 1);
      await pending;
      if (!released) {
        if (movedOriginal) {
          fs.unlinkSync(owner.path);
          fs.renameSync(moved, owner.path);
        } else if (ending === "replace") {
          fs.writeFileSync(owner.path, original);
        }
        owner.release();
      }
      await store.close();
    }
    if (ending !== "resume") {
      expect(await read(await open(file))).toEqual([]);
    }
  },
);

async function openWithRetainedAccess(pathname: string) {
  const capture = stateOwner.captureStateDatabaseAccess;
  const access = await capture(pathname);
  vi.spyOn(stateOwner, "captureStateDatabaseAccess").mockImplementation(async (location) =>
    location === pathname ? access : capture(location),
  );
  return { store: await open(pathname), access };
}

function holdDatabaseAdmission(
  pathname: string,
  access: Awaited<ReturnType<typeof stateOwner.captureStateDatabaseAccess>>,
) {
  const pending = new StateDatabaseAdmissionPendingError(pathname, "Schema publication pending");
  const prepareAccess = access.prepareAccess.bind(access);
  let held = true;
  vi.spyOn(access, "prepareAccess").mockImplementation(async (options) => {
    if (held) {
      throw pending;
    }
    return prepareAccess(options);
  });
  const sleeping = createDeferredCore();
  const sleepWithAbort = retry.sleepWithAbort;
  vi.spyOn(retry, "sleepWithAbort").mockImplementation((...args) => {
    sleeping.resolve();
    return sleepWithAbort(...args);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return {
    pending,
    release: () => {
      held = false;
    },
    expectWaiting: (operation: Promise<unknown>) =>
      expect(
        Promise.race([sleeping.promise.then(() => "waiting"), operation.then(() => "settled")]),
      ).resolves.toBe("waiting"),
    async finish(operation: Promise<unknown>) {
      held = false;
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await operation;
    },
  };
}

function collectRequests(include: (event: DiagnosticWorkerRequestFields) => boolean) {
  const requests: DiagnosticWorkerRequestFields[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "worker.request" && include(event)) {
          requests.push(event);
        }
      },
      { include: ["worker.request"] },
    ),
  );
  return requests;
}

function holdReply(matches: (worker: Worker, reply: unknown) => boolean) {
  const held = createDeferredCore();
  let publish: (() => void) | undefined;
  const messages = vi.spyOn(Worker.prototype, "emit");
  messages.mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === "message" && matches(this, args[0])) {
      messages.mockRestore();
      publish = () => EventEmitter.prototype.emit.call(this, event, ...args);
      held.resolve();
      return true;
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  return {
    held: held.promise,
    restore: () => messages.mockRestore(),
    release() {
      const reply = publish;
      publish = undefined;
      reply?.();
    },
  };
}

function holdOpenReply(pathname: string) {
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const hold = holdReply(
    (worker, reply) =>
      isRecord(reply) &&
      typeof reply.ok === "boolean" &&
      requests.mock.calls.some(
        ([request], index) =>
          requests.mock.contexts[index] === worker &&
          isRecord(request) &&
          request.type === "open" &&
          request.databasePath === pathname &&
          request.id === reply.id,
      ),
  );
  return {
    ...hold,
    restore() {
      requests.mockRestore();
      hold.restore();
    },
  };
}

function openBroker(broker: SqliteWorkerBroker, pathname: string, cancel?: AbortController) {
  return broker.open<FixtureOperations>(
    {
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath: pathname,
      input: undefined,
    },
    undefined,
    undefined,
    { signal: cancel?.signal },
  );
}

it("waits for schema publication after opening, then dispatches queued writes once in order", async () => {
  const file = databasePath();
  const { store, access } = await openWithRetainedAccess(file);
  await waitForDiagnosticEventsDrained();
  const completed = collectRequests((event) => event.phase === "completed");
  const admission = holdDatabaseAdmission(file, access);
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const first = append(store, "first");
  const second = append(store, "second");
  const outcomes = Promise.allSettled([first, second]);
  try {
    await admission.expectWaiting(outcomes);
    expect(requests).not.toHaveBeenCalled();
    admission.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcomes).toMatchObject([
      { status: "fulfilled", value: { writes: 1 } },
      { status: "fulfilled", value: { writes: 2 } },
    ]);
    expect(await read(store)).toEqual(["first", "second"]);
    await waitForDiagnosticEventsDrained();
    expect(completed).toHaveLength(3);
    for (const { timing } of completed) {
      assert(timing);
      const stages = [
        "enqueued",
        "dispatched",
        "posted",
        "received",
        "inputReady",
        "executeStarted",
        "executeFinished",
        "serialized",
        "replied",
        "replyReceived",
      ] as const;
      const stamps = stages.map((stage) => timing[stage]);
      expect(stamps).toEqual(stages.map(() => expect.any(Number)));
      expect(stamps).toEqual(stamps.toSorted((a, b) => a! - b!));
      expect(timing.postFinished).toBeGreaterThanOrEqual(timing.posted!);
    }
  } finally {
    await admission.finish(outcomes);
  }
});

it.each(["cancellation", "revocation", "deadline"] as const)(
  "settles an unsent schema waiter after %s without writing",
  async (ending) => {
    const file = databasePath();
    const { store, access } = await openWithRetainedAccess(file);
    const admission = holdDatabaseAdmission(file, access);
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cancel = new AbortController();
    const revoked = new Error("Write authority revoked");
    let current = true;
    const pending = runSqliteWorkerStoreOperation(
      store,
      (scope) =>
        scope.execute({ type: "append", input: { value: "refused" } }, { signal: cancel.signal }),
      undefined,
      () => {
        if (!current) {
          throw revoked;
        }
      },
    );
    const outcome = Promise.allSettled([pending]);
    try {
      await admission.expectWaiting(outcome);
      const canceled = new Error("Write canceled");
      if (ending === "cancellation") {
        cancel.abort(canceled);
      } else {
        if (ending === "revocation") {
          current = false;
          admission.release();
        } else {
          now = OPENCLAW_SQLITE_BUSY_TIMEOUT_MS;
        }
        await vi.advanceTimersByTimeAsync(10);
      }
      const expectedReason =
        ending === "cancellation"
          ? { name: "AbortError", cause: canceled }
          : ending === "revocation"
            ? revoked
            : admission.pending;
      expect(await outcome).toMatchObject([rejectedOutcome(expectedReason)]);
      expect(requests).not.toHaveBeenCalled();
      admission.release();
      expect(await append(store, "successor")).toMatchObject({ writes: 1 });
      expect(await read(store)).toEqual(["successor"]);
    } finally {
      await admission.finish(outcome);
    }
  },
);

it("does not wait on permanent refusal or another database's admission", async () => {
  const file = databasePath();
  const { store, access } = await openWithRetainedAccess(file);
  const requests = vi.spyOn(Worker.prototype, "postMessage");
  const sleep = vi.spyOn(retry, "sleepWithAbort");
  const assertion = vi.spyOn(access, "prepareAccess");
  for (const error of [
    new Error("Maintenance authority required"),
    new StateDatabaseAdmissionPendingError(databasePath(), "Another database is unavailable"),
  ]) {
    assertion.mockImplementation(() => {
      throw error;
    });
    await expect(append(store, "refused")).rejects.toBe(error);
  }
  expect(sleep).not.toHaveBeenCalled();
  expect(requests).not.toHaveBeenCalled();
  assertion.mockRestore();
  expect(await read(store)).toEqual([]);
});

it("borrows an open database while an unrelated cold open awaits its reply", async ({ signal }) => {
  const broker = new SqliteWorkerBroker();
  const warmPath = databasePath();
  const coldPath = databasePath();
  const openStore = (pathname: string) => openBroker(broker, pathname);
  const pending: Promise<unknown>[] = [];
  const hold = holdOpenReply(coldPath);
  try {
    const warm = await openStore(warmPath);
    assert(warm, "Warm store missing");
    const seed = await append(warm, "seed");
    const cold = openStore(coldPath);
    pending.push(cold);
    await withinTest(hold.held, signal);
    expect(await withinTest(read(warm), signal)).toEqual(["seed"]);

    const borrowing = openStore(warmPath);
    pending.push(borrowing);
    const borrowed = await withinTest(borrowing, signal);
    assert(borrowed, "Borrowed store missing");
    expect(await withinTest(append(borrowed, "borrowed"), signal)).toEqual({
      ...seed,
      writes: 2,
    });
    await borrowed.close();
    expect(await append(warm, "original survives")).toEqual({ ...seed, writes: 3 });
    expect(await read(warm)).toEqual(["seed", "borrowed", "original survives"]);
  } finally {
    hold.restore();
    hold.release();
    await Promise.allSettled(pending);
    await broker.close();
  }
});

it("cancels queued opens without overtaking an accepted open or abandoning its settlement", async ({
  signal,
}) => {
  const broker = new SqliteWorkerBroker();
  const acceptedCancel = new AbortController();
  const queuedCancel = new AbortController();
  const acceptedPath = databasePath();
  const queuedPath = databasePath();
  const successorPath = databasePath();
  const hold = holdOpenReply(acceptedPath);
  const openStore = (pathname: string, cancel?: AbortController) =>
    openBroker(broker, pathname, cancel);
  const accepted = openStore(acceptedPath, acceptedCancel);
  const acceptedOutcome = Promise.allSettled([accepted]);
  const pending: Promise<unknown>[] = [accepted];
  try {
    await withinTest(hold.held, signal);
    const queued = openStore(queuedPath, queuedCancel);
    const successor = openStore(successorPath);
    pending.push(queued, successor);
    const reason = new Error("queued open deadline expired");
    const rejected = expect(queued).rejects.toBe(reason);
    queuedCancel.abort(reason);
    acceptedCancel.abort(new Error("accepted open still owns native settlement"));
    await withinTest(rejected, signal);
    expect(existsSync(queuedPath)).toBe(false);
    expect(existsSync(successorPath)).toBe(false);
    hold.release();
    await expect(acceptedOutcome).resolves.toMatchObject([{ status: "fulfilled" }]);
    const next = await withinTest(successor, signal);
    assert(next, "Successor store missing");
    expect(await append(next, "survived canceled open")).toMatchObject({ writes: 1 });
    expect(existsSync(queuedPath)).toBe(false);
  } finally {
    hold.restore();
    hold.release();
    await Promise.allSettled(pending);
    await broker.close();
  }
});

poolIt("keeps an independent database responsive while another worker is at capacity", async () => {
  const busy = await open(databasePath());
  const independent = await open(databasePath());
  const busyThread = (await append(busy, "before saturation")).threadId;
  await waitForDiagnosticEventsDrained();
  const requests = collectRequests((event) => event.kind === "sqlite_writer");
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const hold = holdReply((worker) => worker.threadId === busyThread);
  const accepted = Promise.allSettled(queueRows.map((value) => append(busy, value)));
  const canceled = new Error("Waiting command canceled");
  const revoked = new Error("Waiting command authority revoked");
  let waiting: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await hold.held;
    now = 10;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const completed = expect(append(independent, "independent write")).resolves.toMatchObject({
      writes: 1,
    });
    // A different worker must not spend the busy worker's admission timeout waiting for room.
    vi.advanceTimersByTime(10_000);
    await completed;
    expect(await read(independent)).toEqual(["independent write"]);
    vi.useRealTimers();
    const cancel = new AbortController();
    let current = true;
    waiting = Promise.allSettled([
      append(busy, "canceled", cancel.signal),
      runSqliteWorkerStoreOperation(
        busy,
        (scope) => scope.execute({ type: "append", input: { value: "revoked" } }),
        undefined,
        () => {
          if (!current) {
            throw revoked;
          }
        },
      ),
      append(busy, "oldest surviving waiter"),
      append(busy, "later arrival"),
    ]);
    now = 25;
    current = false;
    cancel.abort(canceled);
    await waitForDiagnosticEventsDrained();
    expect(requests.at(-1)).toMatchObject({ phase: "completed", queueDepth: 130 });
  } finally {
    vi.useRealTimers();
    hold.restore();
    hold.release();
    expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
  }
  expect(await waiting).toMatchObject([
    rejectedOutcome(canceled),
    rejectedOutcome(revoked),
    { status: "fulfilled" },
    { status: "fulfilled" },
  ]);
  expect(await read(busy)).toEqual([
    "before saturation",
    ...queueRows,
    "oldest surviving waiter",
    "later arrival",
  ]);
  await waitForDiagnosticEventsDrained();
  // Admission retries retain one observation; the canceled waiter never starts.
  expect(requests.filter((event) => event.phase === "queued")).toHaveLength(135);
  expect(requests.filter((event) => event.phase === "started")).toHaveLength(134);
  expect(requests.filter((event) => event.phase === "completed")).toHaveLength(135);
  expect(Math.max(...requests.map((event) => event.queueDepth))).toBe(131);
  expect(requests.at(-1)?.queueDepth).toBe(0);
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: "started", queueWaitMs: 25 }),
      expect.objectContaining({ phase: "started", queueWaitMs: 15 }),
      expect.objectContaining({ phase: "completed", durationMs: 25 }),
    ]),
  );
});

it.each([
  { writeAdmission: false, revoke: false },
  { writeAdmission: false, revoke: true },
  { writeAdmission: true, revoke: false },
])(
  "retains queued command context and live ownership (write admission: $writeAdmission, revoke: $revoke)",
  async ({ writeAdmission, revoke }) => {
    const file = databasePath();
    const store = await open(file);
    const caller = new AsyncLocalStorage<{ current: boolean }>();
    const owner = { current: true };
    const revoked = new Error("Queued command owner was revoked");
    const assertCurrent = () => {
      if (caller.getStore() !== owner) {
        throw new Error("Queued command lost its caller context");
      }
      if (!owner.current) {
        throw revoked;
      }
    };
    const write = (scope: Pick<SqliteWorkerStore<FixtureOperations>, "execute">) =>
      scope.execute({ type: "append", input: { value: "queued" } });

    // Both commands enqueue before a Worker reply can dispatch the guarded follower.
    const predecessor = append(store, "before");
    const queued = caller.run(owner, () =>
      writeAdmission
        ? runSqliteWorkerStoreWrite(store, write, assertCurrent, [file])
        : runSqliteWorkerStoreOperation(store, write, undefined, assertCurrent),
    );
    const outcomes = Promise.allSettled([predecessor, queued]);
    owner.current = !revoke;

    const [first, second] = await outcomes;
    expect(first.status).toBe("fulfilled");
    if (revoke) {
      expect(second).toEqual(rejectedOutcome(revoked));
    } else {
      expect(second.status).toBe("fulfilled");
    }
    expect(await read(store)).toEqual(revoke ? ["before"] : ["before", "queued"]);
    expect(caller.getStore()).toBeUndefined();
  },
);

it.each(["drain", "timeout"] as const)(
  "releases admission waiters on %s without losing accepted writes",
  async (action) => {
    const file = databasePath();
    const store = await open(file);
    const accepted = Promise.allSettled(queueRows.map((value) => append(store, value)));
    const cancel = new AbortController();
    const logger = logging.getChildLogger();
    const warn = vi.spyOn(logger, "warn");
    vi.spyOn(logging, "getChildLogger").mockReturnValue(logger);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const waiters = Promise.allSettled(
      Array.from({ length: 2 }, () => append(store, "never dispatched", cancel.signal)),
    );
    let settled = false;
    void waiters.then(() => {
      settled = true;
    });
    let closing: Promise<void> | undefined;
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      if (action === "drain") {
        closing = drainGlobalSingletonLifecycleState("restart");
      } else {
        vi.advanceTimersByTime(9_999);
        await Promise.resolve();
        expect(settled).toBe(false);
        vi.advanceTimersByTime(1);
      }
      expect(await waiters).toMatchObject(
        Array.from({ length: 2 }, () => rejectedOutcome({ code: "overloaded" })),
      );
      if (action === "timeout") {
        expect(warn).toHaveBeenCalledExactlyOnceWith("SQLite worker admission delayed", {
          queueDepth: 2,
          waitMs: 10_000,
        });
      }
    } finally {
      vi.useRealTimers();
      cancel.abort();
      expect((await accepted).every((outcome) => outcome.status === "fulfilled")).toBe(true);
      await closing;
    }
    const reader = action === "drain" ? await open(file) : store;
    expect(await read(reader)).toEqual(queueRows);
    expect(await append(reader, "capacity returned")).toMatchObject({
      writes: action === "drain" ? 1 : 129,
    });
  },
);

it("charges admission waiters to the byte budget and releases canceled reservations", async () => {
  const store = await open(databasePath());
  const independent = await open(databasePath());
  const concurrentInputs = Array.from({ length: 3 }, () =>
    reserveSqliteWorkerInputPreparation(64 * 1024 * 1024),
  );
  const accepted = Promise.allSettled(Array.from({ length: 128 }, () => read(store)));
  const cancel = new AbortController();
  const waiting = append(store, "x".repeat(40 * 1024 * 1024), cancel.signal);
  const outcome = Promise.allSettled([waiting]);
  try {
    await expect(append(independent, "x".repeat(30 * 1024 * 1024))).rejects.toMatchObject({
      code: "overloaded",
    });
    cancel.abort(new Error("release waiting bytes"));
    expect(await outcome).toMatchObject([rejectedOutcome({ message: "release waiting bytes" })]);
    const replacement = new AbortController();
    const replacementOutcome = Promise.allSettled([
      append(store, "x".repeat(40 * 1024 * 1024), replacement.signal),
    ]);
    replacement.abort(new Error("replacement admitted"));
    expect(await replacementOutcome).toMatchObject([
      rejectedOutcome({ message: "replacement admitted" }),
    ]);
  } finally {
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    cancel.abort();
    await outcome;
    await accepted;
  }
  expect(await read(store)).toEqual([]);
});

poolIt.each([1, 128])("uses two worker threads for %i available CPUs", async (cores) => {
  const workers = 2;
  vi.spyOn(os, "availableParallelism").mockReturnValue(cores);
  const broker = new SqliteWorkerBroker();
  try {
    const threads = new Set<number>();
    for (let index = 0; index <= workers; index++) {
      const store = await openBroker(broker, databasePath());
      assert(store, "Fixture store missing");
      threads.add((await append(store, "thread count")).threadId);
    }
    expect(threads.size).toBe(workers);
  } finally {
    await broker.close();
  }
});
