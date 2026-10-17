import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
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
  openOpenClawStateWorkerCleanupStore,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import * as sqliteWorkers from "./sqlite-worker-store.js";
import {
  getSqliteWorkerActorIdentity,
  openSqliteWorkerStore,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("shared-state-worker-idle"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
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

async function fixture() {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const open = async (context: OpenClawStateWorkerContext) => {
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      // Exercise native idle ownership without preparing the unrelated task-flow runtime.
      const read = () =>
        executeOpenClawStateWorker(context, {
          type: "deviceAuth.read",
          input: { deviceId: "idle-fixture:healthy", role: "operator", readOnly: false },
        });
      expect(await read()).toEqual({ entry: null, expectedToken: null });
      const worker = messages.mock.contexts[0];
      if (!(worker instanceof Worker)) {
        throw new Error("Expected the canonical shared-state worker");
      }
      return { context, worker, read };
    } finally {
      messages.mockRestore();
    }
  };
  const first = await open(
    captureOpenClawStateWorkerContext({
      env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-") },
    }),
  );
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
    ...first,
    open,
    scheduled,
  };
}

it("retains pressure retirement across path close and releases its subscription after drainage", async () => {
  const pressure = channel("openclaw.memory.critical");
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-pressure-") };
  const context = captureOpenClawStateWorkerContext({ env });
  await expect(
    openOpenClawStateWorkerCleanupStore(
      context.admission.databasePath,
      context,
      context.admission.assertCurrent,
      context.admission.identity,
    ),
  ).resolves.toBeUndefined();
  expect(pressure.hasSubscribers).toBe(false);
  await expect(
    runOpenClawStateWorkerOperation(context, (scope) => scope.execute(read), {
      existingOnly: true,
    }),
  ).resolves.toBeUndefined();
  expect(pressure.hasSubscribers).toBe(false);

  const first = await fixture();
  const second = await first.open(context);
  expect(pressure.hasSubscribers).toBe(true);
  await closeOpenClawStateDatabaseByPathAsync(first.context.admission.databasePath);
  expect(pressure.hasSubscribers).toBe(true);
  expect(second.worker.threadId).not.toBe(-1);
  const secondExited = once(second.worker, "exit");
  pressure.publish({});
  await secondExited;
  await closeOpenClawStateDatabaseAsync();
  expect(pressure.hasSubscribers).toBe(false);

  const reopened = await first.open(captureOpenClawStateWorkerContext({ env }));
  expect(pressure.hasSubscribers).toBe(true);
  const reopenedExited = once(reopened.worker, "exit");
  pressure.publish({});
  await reopenedExited;
  await closeOpenClawStateDatabaseAsync();
  expect(pressure.hasSubscribers).toBe(false);
});

it("reuses the original worker until its 30-minute idle deadline, resetting it on real work", async () => {
  const f = await fixture();
  const originalExpiry = f.scheduled(30 * minute);
  expect(await f.read()).toEqual({ entry: null, expectedToken: null });
  originalExpiry();
  expect(f.worker.threadId).not.toBe(-1);
  const exited = once(f.worker, "exit");
  f.scheduled(30 * minute)();
  await exited;
  expect(await f.read()).toEqual({ entry: null, expectedToken: null });
});

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;
const read = {
  type: "deviceAuth.read",
  input: { deviceId: "idle-fixture:idle-custody", role: "operator", readOnly: false },
} as const;

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

poolIt(
  "reclaims only an idle shared-state client at 64 and reopens its persisted state",
  async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-capacity-") };
    const context = captureOpenClawStateWorkerContext({ env });
    const first = await openClient(context);
    const identityKey = "idle-fixture:capacity-reopen";
    const identity = await executeOpenClawStateWorker(context, {
      type: "deviceIdentity.load",
      input: { identityKey },
    });
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const peerContext = maintenance.run(() => captureOpenClawStateWorkerContext({ env }));
    const peer = await openClient(peerContext);
    expect(peer.actor).toBe(first.actor);

    const fillerPath = path.join(dirs.make("openclaw-worker-capacity-fill-"), "store.sqlite");
    const fillers: SqliteWorkerStore<FixtureOperations>[] = [];
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let active: Promise<unknown> | undefined;
    try {
      for (let index = 0; index < 62; index += 1) {
        fillers.push(
          await openSqliteWorkerStore<FixtureOperations>({
            moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
            databasePath: fillerPath,
            input: undefined,
          }),
        );
      }
      const next = captureOpenClawStateWorkerContext({
        env: { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-capacity-next-") },
      });
      active = runOpenClawStateWorkerOperation(peerContext, async (scope) => {
        entered.resolve();
        await resume.promise;
        return scope.execute(read);
      });
      await entered.promise;
      await expect(executeOpenClawStateWorker(next, read)).rejects.toMatchObject({
        code: "overloaded",
      });
      expect(getSqliteWorkerActorIdentity(first.store)).toBe(first.actor);
      expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);

      resume.resolve();
      await expect(active).resolves.toEqual({ entry: null, expectedToken: null });
      await expect(executeOpenClawStateWorker(next, read)).resolves.toEqual({
        entry: null,
        expectedToken: null,
      });
      await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
      expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
      await expect(executeOpenClawStateWorker(peerContext, read)).resolves.toEqual({
        entry: null,
        expectedToken: null,
      });

      await expect(
        executeOpenClawStateWorker(context, {
          type: "deviceIdentity.load",
          input: { identityKey },
        }),
      ).resolves.toEqual(identity);
      const reopened = await openClient(context);
      expect(reopened.store).not.toBe(first.store);
      expect(reopened.actor).toBe(first.actor);
    } finally {
      resume.resolve();
      await Promise.allSettled([
        active,
        ...fillers.map((store) => store.close()),
        maintenance.close(),
      ]);
    }
  },
);

poolIt("joins expiring idle-client maintenance without retiring a healthy co-user", async () => {
  const f = await fixture();
  const context = f.context;
  const env = context.environment;
  const first = await openClient(context);
  const expire = f.scheduled(30 * minute);
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

    expire();
    await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
    let idleClosed = false;
    idleClosing = first.store.close().then(() => {
      idleClosed = true;
    });
    await expect(
      runOpenClawStateWorkerOperation(peerContext, (scope) => scope.execute(read)),
    ).resolves.toEqual({ entry: null, expectedToken: null });
    expect(idleClosed).toBe(false);
    expect(f.worker.threadId).not.toBe(-1);

    resume.resolve();
    await expect(accepted).resolves.toEqual({ entry: null, expectedToken: null });
    await idleClosing;
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
    await expect(
      runOpenClawStateWorkerOperation(peerContext, (scope) => scope.execute(read)),
    ).resolves.toEqual({ entry: null, expectedToken: null });

    expect(f.worker.threadId).not.toBe(-1);
    peerClosing = maintenance.close();
    await peerClosing;
    expect(f.worker.threadId).toBe(-1);
  } finally {
    resume.resolve();
    await Promise.allSettled([accepted, idleClosing, peerClosing, maintenance.close()]);
  }
});

poolIt.each([undefined, "agent-resources", "shared-handles"] as const)(
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

poolIt.each(["ordinary", "cleanup"] as const)(
  "reopens an idle failed actor through %s without waiting for its other maintenance client to close",
  async (entrypoint) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-worker-idle-reopen-") };
    const firstScope = createOpenClawDatabaseMaintenanceScope();
    const peerScope = createOpenClawDatabaseMaintenanceScope();
    const firstContext = firstScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const peerContext = peerScope.run(() => captureOpenClawStateWorkerContext({ env }));
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    let stopped: Promise<number> | undefined;
    let cleanupStore: Awaited<ReturnType<typeof openOpenClawStateWorkerCleanupStore>>;
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

      const reopened =
        entrypoint === "ordinary"
          ? (await openClient(firstContext)).store
          : (cleanupStore = await openOpenClawStateWorkerCleanupStore(
              firstContext.admission.databasePath,
              firstContext,
              firstContext.admission.assertCurrent,
              firstContext.admission.identity,
            ));
      if (!reopened) {
        throw new Error("Expected cleanup to retain the existing shared database");
      }
      expect(getSqliteWorkerActorIdentity(reopened) === first.actor).toBe(false);
      await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
      await cleanupStore?.close();
      cleanupStore = undefined;
      await expect(
        runOpenClawStateWorkerOperation(firstContext, (scope) => scope.execute(read)),
      ).resolves.toEqual({ entry: null, expectedToken: null });
    } finally {
      messages.mockRestore();
      await Promise.allSettled([
        stopped,
        cleanupStore?.close(),
        firstScope.close(),
        peerScope.close(),
      ]);
    }
  },
);

poolIt("joins adopted actor custody instead of its earlier per-client failure", async () => {
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
