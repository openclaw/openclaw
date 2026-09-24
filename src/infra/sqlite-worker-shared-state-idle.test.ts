import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { MessagePort, Worker, type Transferable } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import * as sqliteWorkers from "./sqlite-worker-store.js";
import { getSqliteWorkerActorIdentity } from "./sqlite-worker-store.js";

// Keep the shared-state owner on the fixture backend across reopenings.
vi.mock("./runtime-worker-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-worker-url.js")>();
  const { runtimeProcessEntrypoints } = await import("./runtime-process-entrypoints.js");
  return {
    ...actual,
    resolveRuntimeWorkerUrl: (params: Parameters<typeof actual.resolveRuntimeWorkerUrl>[0]) =>
      params.sourceWorkerName === runtimeProcessEntrypoints.sharedStateStore.sourceWorkerName
        ? new URL("./sqlite-worker-shared-state-idle-fixture.test-support.ts", import.meta.url)
        : actual.resolveRuntimeWorkerUrl(params),
  };
});

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const minute = 60_000;

async function fixture(mode: "healthy" | "local-reader" | "unsettled-inspection" = "healthy") {
  const context = captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-") },
  });
  const now = performance.now.bind(performance);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  const timers = vi.spyOn(globalThis, "setTimeout");
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  const read = () =>
    executeOpenClawStateWorker(context, {
      type: "flows.list",
      input: { ownerKey: `agent:main:${mode}` },
    });
  expect(await read()).toEqual([]);
  const worker = messages.mock.contexts[0];
  messages.mockRestore();
  if (!(worker instanceof Worker)) {
    throw new Error("Expected the canonical shared-state worker");
  }
  const scheduled = (delay: number) => {
    const index = timers.mock.calls.findLastIndex(
      (call) => typeof call[1] === "number" && call[1] <= delay && call[1] > delay - 1_000,
    );
    const callback = timers.mock.calls[index]?.[0];
    if (typeof callback !== "function") {
      throw new Error(`Expected idle callback after ${delay} ms`);
    }
    return () => {
      const timer = timers.mock.results[index];
      if (timer?.type === "return") {
        clearTimeout(timer.value);
      }
      callback();
    };
  };
  return {
    context,
    worker,
    read,
    scheduled,
    advance: (duration: number) => {
      elapsed += duration;
    },
  };
}

it("retains the original healthy worker after one minute and closes it after 30 minutes", async () => {
  const f = await fixture();
  f.advance(minute);
  f.scheduled(minute)();
  // Joining a real call also joins the original owner's retirement, if it retired at one minute.
  expect(await f.read()).toEqual([]);
  expect(f.worker.threadId).not.toBe(-1);
  f.advance(minute);
  f.scheduled(minute)();
  await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
  expect(f.worker.threadId).not.toBe(-1);
  const exited = once(f.worker, "exit");
  f.advance(29 * minute);
  f.scheduled(29 * minute)();
  await exited;
  expect(await f.read()).toEqual([]);
});

it("retires an unavailable actor even when its completed idle result is healthy", async () => {
  const f = await fixture();
  const available = vi
    .spyOn(sqliteWorkers, "isSqliteWorkerStoreAvailable")
    .mockReturnValueOnce(false);
  try {
    f.advance(minute);
    f.scheduled(minute)();
    await vi.waitFor(() => expect(f.worker.threadId).toBe(-1));
    expect(await f.read()).toEqual([]);
  } finally {
    available.mockRestore();
  }
});

it("retires a worker with an untracked local reader and releases its actual WAL pin", async () => {
  const f = await fixture("local-reader");
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(f.context.admission.databasePath);
  try {
    writer.exec("PRAGMA busy_timeout=0; CREATE TABLE idle_probe (value TEXT)");
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(1);
    const exited = once(f.worker, "exit");
    f.advance(minute);
    f.scheduled(minute)();
    await exited;
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
  } finally {
    writer.close();
  }
});

it("keeps a healthy worker when another connection holds the WAL reader", async () => {
  const f = await fixture();
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(f.context.admission.databasePath);
  const reader = new DatabaseSync(f.context.admission.databasePath);
  try {
    writer.exec("PRAGMA busy_timeout=0; CREATE TABLE idle_probe (value TEXT)");
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM sqlite_schema").get();
    writer.exec("INSERT INTO idle_probe VALUES ('after-reader')");
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(1);
    f.advance(minute);
    f.scheduled(minute)();
    await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
    expect(f.worker.threadId).not.toBe(-1);
    expect(await f.read()).toEqual([]);
    expect(f.worker.threadId).not.toBe(-1);
  } finally {
    if (reader.isTransaction) {
      reader.exec("ROLLBACK");
    }
    reader.close();
    writer.close();
  }
});

it("ignores an inspection result and old expiry when real work resumes", async () => {
  const f = await fixture();
  const postMessage = f.worker.postMessage.bind(f.worker);
  const dispatched = createDeferredCore();
  let resume: (() => void) | undefined;
  const send = vi
    .spyOn(f.worker, "postMessage")
    .mockImplementation((request: SqliteWorkerRequest, transfers?: readonly Transferable[]) => {
      if (
        request.type === "execute" &&
        deserialize(request.input).type === "database.inspectIdle"
      ) {
        resume = () => postMessage(request, transfers);
        dispatched.resolve();
        return;
      }
      return postMessage(request, transfers);
    });
  const oldInspection = f.scheduled(minute);
  f.advance(minute);
  oldInspection();
  await dispatched.promise;
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const active = runOpenClawStateWorkerOperation(f.context, async (scope) => {
    entered.resolve();
    await finish.promise;
    return scope.execute({ type: "flows.list", input: { ownerKey: "agent:main:idle" } });
  });
  await entered.promise;
  send.mockRestore();
  try {
    if (!resume) {
      throw new Error("Expected a held native inspection request");
    }
    resume();
    f.advance(30 * minute);
    oldInspection();
    expect(f.worker.threadId).not.toBe(-1);
  } finally {
    finish.resolve();
  }
  expect(await active).toEqual([]);
  oldInspection();
  f.advance(minute);
  f.scheduled(minute)();
  await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
  expect(f.worker.threadId).not.toBe(-1);
});

it("replaces a failed idle actor after an enclosing callback settles", async () => {
  const f = await fixture("unsettled-inspection");
  const nativePost = vi.spyOn(MessagePort.prototype, "postMessage");
  nativePost.mockRestore();
  let resume: (() => void) | undefined;
  const send = vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
    this: MessagePort,
    message,
    transfers,
  ) {
    if (isRecord(message) && message.type === "accepted" && Object.hasOwn(message, "admission")) {
      // Hold the acquired-custody grant, after live authority has accepted this inspection.
      send.mockRestore();
      resume = () => nativePost.call(this, message, transfers);
      return;
    }
    return nativePost.call(this, message, transfers);
  });
  f.advance(minute);
  f.scheduled(minute)();
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const escape = createDeferredCore<never>();
  void escape.promise.catch(() => {});
  let active: Promise<string> | undefined;
  try {
    await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
    if (!resume) {
      throw new Error("Expected an admitted native inspection");
    }
    active = runOpenClawStateWorkerOperation(f.context, () =>
      Promise.race([
        (async () => {
          entered.resolve();
          await finish.promise;
          await expect(f.read()).rejects.toMatchObject({ code: "unavailable" });
          return "completed without dispatch";
        })(),
        escape.promise,
      ]),
    );
    await entered.promise;
    const exited = once(f.worker, "exit");
    resume();
    resume = undefined;
    await exited;
    await nextTurn();
    finish.resolve();
    let settled = false;
    void active.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await active).toBe("completed without dispatch");
    await nextTurn();
    expect(await f.read()).toEqual([]);
  } finally {
    send.mockRestore();
    resume?.();
    finish.resolve();
    escape.reject(new Error("Release the enclosing fixture after failed observation"));
    await active?.catch(() => {});
  }
});

const nodeIt = process.versions.bun ? it.skip : it;
const read = { type: "flows.list", input: { ownerKey: "agent:main:idle-custody" } } as const;

async function openClient(context: OpenClawStateWorkerContext) {
  const operations = vi.spyOn(sqliteWorkers, "runSqliteWorkerStoreOperation");
  try {
    await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(read));
    const store = operations.mock.calls.at(-1)?.[0];
    if (!store) {
      throw new Error("Expected the canonical shared-state client's operation");
    }
    return { store, actor: getSqliteWorkerActorIdentity(store) };
  } finally {
    operations.mockRestore();
  }
}

nodeIt("joins expiring idle-client maintenance without retiring a healthy co-user", async () => {
  const f = await fixture();
  const context = f.context;
  const env = context.environment;
  const first = await openClient(context);
  f.advance(minute);
  f.scheduled(minute)();
  await vi.waitFor(() => expect(f.scheduled(29 * minute)).toBeTypeOf("function"));
  const expire = f.scheduled(29 * minute);
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  const resume = createDeferred();
  const entered = createDeferred();
  let accepted: Promise<unknown> | undefined;
  let idleClosing: Promise<void> | undefined;
  let peerClosing: Promise<void> | undefined;
  try {
    const peerContext = maintenance.run(() => captureOpenClawStateWorkerContext({ env }));
    const peer = await openClient(peerContext);
    expect(peer.actor).toBe(first.actor);
    accepted = sqliteWorkers.runSqliteWorkerStoreOperation(
      first.store,
      async (scope) => {
        entered.resolve();
        await resume.promise;
        return scope.execute(read);
      },
      context,
    );
    await Promise.race([entered.promise, accepted]);

    f.advance(29 * minute);
    expire();
    await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
    let idleClosed = false;
    idleClosing = first.store.close().then(() => {
      idleClosed = true;
    });
    await expect(
      runOpenClawStateWorkerOperation(peerContext, (scope) => scope.execute(read)),
    ).resolves.toEqual([]);
    expect(idleClosed).toBe(false);
    expect(f.worker.threadId).not.toBe(-1);

    resume.resolve();
    await expect(accepted).resolves.toEqual([]);
    await idleClosing;
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
    await expect(
      runOpenClawStateWorkerOperation(peerContext, (scope) => scope.execute(read)),
    ).resolves.toEqual([]);

    expect(f.worker.threadId).not.toBe(-1);
    peerClosing = maintenance.close();
    await peerClosing;
    expect(f.worker.threadId).toBe(-1);
  } finally {
    resume.resolve();
    await Promise.allSettled([accepted, idleClosing, peerClosing, maintenance.close()]);
  }
});

nodeIt.each([undefined, "agent-resources", "shared-handles"] as const)(
  "joins a tracked maintenance callback before retiring its failed actor and idle co-user (during resource cleanup: %s)",
  async (duringCleanup) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-maintenance-drain-") };
    const firstScope = createOpenClawDatabaseMaintenanceScope();
    const peerScope = createOpenClawDatabaseMaintenanceScope();
    const firstContext = firstScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const peerContext = peerScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    let accepted: Promise<string> | undefined;
    let closing: Promise<unknown> | undefined;
    let stopped: Promise<number> | undefined;
    try {
      const first = await openClient(firstContext);
      const peer = await openClient(peerContext);
      expect(first.actor === peer.actor).toBe(true);
      const worker = messages.mock.contexts.find((candidate) => candidate instanceof Worker);
      messages.mockRestore();
      if (!(worker instanceof Worker)) {
        throw new Error("Expected the shared native worker");
      }
      const startAccepted = async () => {
        accepted = runOpenClawStateWorkerOperation(firstContext, async () => {
          entered.resolve();
          await resume.promise;
          return "accepted callback completed";
        });
        await Promise.race([entered.promise, accepted]);
      };
      if (duringCleanup) {
        firstScope.own({}, duringCleanup, startAccepted);
      } else {
        await startAccepted();
      }
      let closed = false;
      closing = firstScope.close().then(
        () => {
          closed = true;
        },
        (error: unknown) => {
          closed = true;
          return error;
        },
      );
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Maintenance closed before its tracked callback entered");
        }),
      ]);
      await nextTurn();
      expect(closed).toBe(false);
      expect(getSqliteWorkerActorIdentity(peer.store) === first.actor).toBe(true);

      stopped = worker.terminate();
      await stopped;
      expect(closed).toBe(false);
      await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "unavailable" });
      resume.resolve();
      await expect(accepted).resolves.toBe("accepted callback completed");
      await closing;
      // Observe the old client directly: a fresh shared-owner call could retire it itself.
      await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    } finally {
      messages.mockRestore();
      resume.resolve();
      await Promise.allSettled([accepted, stopped, closing, firstScope.close(), peerScope.close()]);
    }
  },
);

nodeIt(
  "reopens an idle failed actor without waiting for its other maintenance client to close",
  async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-reopen-") };
    const firstScope = createOpenClawDatabaseMaintenanceScope();
    const peerScope = createOpenClawDatabaseMaintenanceScope();
    const firstContext = firstScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const peerContext = peerScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    let stopped: Promise<number> | undefined;
    try {
      const first = await openClient(firstContext);
      const peer = await openClient(peerContext);
      expect(first.actor === peer.actor).toBe(true);
      const worker = messages.mock.contexts.find((candidate) => candidate instanceof Worker);
      messages.mockRestore();
      if (!(worker instanceof Worker)) {
        throw new Error("Expected the shared native worker");
      }
      stopped = worker.terminate();
      await stopped;
      await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "unavailable" });

      const reopened = await openClient(firstContext);
      expect(reopened.actor === first.actor).toBe(false);
      await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
      await expect(
        runOpenClawStateWorkerOperation(firstContext, (scope) => scope.execute(read)),
      ).resolves.toEqual([]);
    } finally {
      messages.mockRestore();
      await Promise.allSettled([stopped, firstScope.close(), peerScope.close()]);
    }
  },
);

nodeIt("joins adopted actor custody instead of its earlier per-client failure", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-adopted-retirement-") };
  const firstScope = createOpenClawDatabaseMaintenanceScope();
  const peerScope = createOpenClawDatabaseMaintenanceScope();
  const firstContext = firstScope.run(() => captureOpenClawStateWorkerContext({ env }));
  const peerContext = peerScope.run(() => captureOpenClawStateWorkerContext({ env }));
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const terminationEntered = createDeferredCore();
  const allowNativeExit = createDeferredCore();
  const nativeExited = createDeferredCore();
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  let accepted: Promise<string> | undefined;
  let firstClosing: Promise<void> | undefined;
  let canonicalClosing: Promise<boolean> | undefined;
  let termination: Promise<number> | undefined;
  let nativeTerminate: (() => Promise<number>) | undefined;
  let restoreTerminate: (() => void) | undefined;
  let worker: Worker | undefined;
  try {
    const first = await openClient(firstContext);
    const peer = await openClient(peerContext);
    expect(first.actor === peer.actor).toBe(true);
    const observedWorker = messages.mock.contexts.find((candidate) => candidate instanceof Worker);
    messages.mockRestore();
    if (!(observedWorker instanceof Worker)) {
      throw new Error("Expected the shared native worker");
    }
    worker = observedWorker;
    worker.once("exit", () => nativeExited.resolve());
    nativeTerminate = worker.terminate.bind(worker);
    const terminate = nativeTerminate;
    const terminating = vi.spyOn(worker, "terminate").mockImplementation(() => {
      terminationEntered.resolve();
      return (termination ??= allowNativeExit.promise.then(terminate));
    });
    restoreTerminate = () => terminating.mockRestore();
    accepted = runOpenClawStateWorkerOperation(peerContext, async () => {
      entered.resolve();
      await resume.promise;
      return "accepted callback completed";
    });
    await Promise.race([entered.promise, accepted]);

    // Exercise the broker's Worker-error boundary, keeping real native exit separately gated.
    const original = new Error("Synthetic actor failure before native exit");
    worker.emit("error", original);
    await terminationEntered.promise;
    await expect(peer.store.execute(read)).rejects.toMatchObject({
      code: "unavailable",
      message: original.message,
    });
    expect(worker.threadId).not.toBe(-1);

    // This first close releases its reference, then waits for the failed Worker's native exit.
    firstClosing = firstScope.close();
    const firstOutcome = firstClosing.then(
      () => ({ settled: true }),
      (error: unknown) => ({ settled: true, error }),
    );
    await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    await nextTurn();

    // The last tracked co-user starts actor retirement and adopts the pending first close.
    resume.resolve();
    await expect(accepted).resolves.toBe("accepted callback completed");
    await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    canonicalClosing = closeOpenClawStateDatabaseByPathAsync(firstContext.admission.databasePath);
    let canonicalSettled = false;
    const canonicalOutcome = canonicalClosing.then(
      () => {
        canonicalSettled = true;
      },
      () => {
        canonicalSettled = true;
      },
    );
    await nextTurn();
    expect(canonicalSettled).toBe(false);
    expect(worker.threadId).not.toBe(-1);

    allowNativeExit.resolve();
    await termination;
    await nativeExited.promise;
    await firstOutcome;
    await canonicalOutcome;
    expect(worker.threadId).toBe(-1);
    // Canonical close joins discharged custody without replaying the prior operation failure.
    await expect(canonicalClosing).resolves.toBeTypeOf("boolean");
  } finally {
    messages.mockRestore();
    resume.resolve();
    allowNativeExit.resolve();
    await Promise.allSettled([accepted, firstClosing, canonicalClosing, termination]);
    restoreTerminate?.();
    if (worker && worker.threadId !== -1) {
      await nativeTerminate?.();
      await nativeExited.promise;
    }
    await Promise.allSettled([firstScope.close(), peerScope.close()]);
    await closeOpenClawStateDatabaseAsync();
  }
});
