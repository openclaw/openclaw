import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
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

const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const closers: (() => unknown)[] = [];
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  return promise;
}
function maintenanceScope() {
  const scope = createOpenClawDatabaseMaintenanceScope();
  closers.push(() => scope.close());
  return scope;
}
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.allSettled(pending.splice(0));
    await Promise.allSettled(closers.splice(0).map((close) => Promise.resolve().then(close)));
    await Promise.allSettled(pending.splice(0));
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const minute = 60_000;
const emptyRead = { entry: null, expectedToken: null };
const contextFor = (prefix: string) =>
  captureOpenClawStateWorkerContext({
    env: { OPENCLAW_STATE_DIR: dirs.make(prefix) },
  });
const openCleanup = (context: OpenClawStateWorkerContext) =>
  openOpenClawStateWorkerCleanupStore(
    context.admission.databasePath,
    context,
    context.admission.assertCurrent,
    context.admission.identity,
  );

function pause() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  releases.push(resume.resolve);
  return {
    entered: entered.promise,
    resume: resume.resolve,
    wait: async () => {
      entered.resolve();
      await resume.promise;
    },
  };
}

async function maintenancePair(prefix: string) {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix) };
  const firstScope = maintenanceScope();
  const peerScope = maintenanceScope();
  const firstContext = firstScope.run(() => captureOpenClawStateWorkerContext({ env }));
  const peerContext = peerScope.run(() => captureOpenClawStateWorkerContext({ env }));
  const first = await openClient(firstContext);
  const peer = await openClient(peerContext);
  expect(peer.actor).toBe(first.actor);
  return { firstScope, firstContext, peerContext, first, peer, worker: first.worker };
}

const readContext = (context: OpenClawStateWorkerContext) =>
  runOpenClawStateWorkerOperation(context, (scope) => scope.execute(read));

async function fixture() {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const open = (context: OpenClawStateWorkerContext) => openClient(context, "idle-fixture:healthy");
  const first = await open(contextFor("openclaw-worker-idle-"));
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
  return { ...first, open, scheduled };
}

it("retains pressure retirement across path close and releases its subscription after drainage", async () => {
  const pressure = channel("openclaw.memory.critical");
  const context = contextFor("openclaw-worker-idle-pressure-");
  await expect(openCleanup(context)).resolves.toBeUndefined();
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

  const reopened = await first.open(
    captureOpenClawStateWorkerContext({ env: context.environment }),
  );
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
  expect(await f.read()).toEqual(emptyRead);
  originalExpiry();
  expect(f.worker.threadId).not.toBe(-1);
  const exited = once(f.worker, "exit");
  f.scheduled(30 * minute)();
  await exited;
  expect(await f.read()).toEqual(emptyRead);
});

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;
const read = {
  type: "deviceAuth.read",
  input: { deviceId: "idle-fixture:idle-custody", role: "operator", readOnly: false },
} as const;

async function openClient(
  context: OpenClawStateWorkerContext,
  deviceId: string = read.input.deviceId,
) {
  const operations = vi.spyOn(sqliteWorkers, "runSqliteWorkerStoreOperation");
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  const readDevice = () =>
    executeOpenClawStateWorker(context, {
      type: "deviceAuth.read",
      input: { ...read.input, deviceId },
    });
  try {
    // Exercise native idle ownership without preparing the unrelated task-flow runtime.
    expect(await readDevice()).toEqual(emptyRead);
    const store = operations.mock.calls.at(-1)?.[0];
    const worker = messages.mock.contexts[0];
    if (!store || !(worker instanceof Worker)) {
      throw new Error("Expected the canonical shared-state client and native worker");
    }
    return { context, store, worker, read: readDevice, actor: getSqliteWorkerActorIdentity(store) };
  } finally {
    operations.mockRestore();
    messages.mockRestore();
  }
}

poolIt(
  "reclaims only an idle shared-state client at 64 and reopens its persisted state",
  async () => {
    const context = contextFor("openclaw-worker-capacity-");
    const first = await openClient(context);
    const identityKey = "idle-fixture:capacity-reopen";
    const loadIdentity = () =>
      executeOpenClawStateWorker(context, {
        type: "deviceIdentity.load",
        input: { identityKey },
      });
    const identity = await loadIdentity();
    const maintenance = maintenanceScope();
    const peerContext = maintenance.run(() =>
      captureOpenClawStateWorkerContext({ env: context.environment }),
    );
    const peer = await openClient(peerContext);
    expect(peer.actor).toBe(first.actor);

    const fillerPath = path.join(dirs.make("openclaw-worker-capacity-fill-"), "store.sqlite");
    const fillers: SqliteWorkerStore<FixtureOperations>[] = [];
    const gate = pause();
    closers.push(() => Promise.allSettled(fillers.map((store) => store.close())));
    for (let index = 0; index < 62; index += 1) {
      fillers.push(
        await openSqliteWorkerStore<FixtureOperations>({
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: fillerPath,
          input: undefined,
        }),
      );
    }
    const next = contextFor("openclaw-worker-capacity-next-");
    const active = track(
      runOpenClawStateWorkerOperation(peerContext, async (scope) => {
        await gate.wait();
        return scope.execute(read);
      }),
    );
    await gate.entered;
    await expect(executeOpenClawStateWorker(next, read)).rejects.toMatchObject({
      code: "overloaded",
    });
    expect(getSqliteWorkerActorIdentity(first.store)).toBe(first.actor);
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);

    gate.resume();
    await expect(active).resolves.toEqual(emptyRead);
    await expect(executeOpenClawStateWorker(next, read)).resolves.toEqual(emptyRead);
    await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
    await expect(executeOpenClawStateWorker(peerContext, read)).resolves.toEqual(emptyRead);

    await expect(loadIdentity()).resolves.toEqual(identity);
    const reopened = await openClient(context);
    expect(reopened.store).not.toBe(first.store);
    expect(reopened.actor).toBe(first.actor);
  },
);

poolIt("joins expiring idle-client maintenance without retiring a healthy co-user", async () => {
  const f = await fixture();
  const context = f.context;
  const env = context.environment;
  const first = await openClient(context);
  const expire = f.scheduled(30 * minute);
  const maintenance = maintenanceScope();
  const gate = pause();
  const peerContext = maintenance.run(() => captureOpenClawStateWorkerContext({ env }));
  const peer = await openClient(peerContext);
  expect(peer.actor).toBe(first.actor);
  const accepted = track(
    sqliteWorkers.runSqliteWorkerStoreOperation(
      first.store,
      async (scope) => {
        await gate.wait();
        return scope.execute(read);
      },
      context,
    ),
  );
  await Promise.race([gate.entered, accepted]);

  expire();
  await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
  expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
  const idleClosed = vi.fn();
  const idleClosing = track(first.store.close().then(idleClosed));
  await expect(readContext(peerContext)).resolves.toEqual(emptyRead);
  expect(idleClosed).not.toHaveBeenCalled();
  expect(f.worker.threadId).not.toBe(-1);

  gate.resume();
  await expect(accepted).resolves.toEqual(emptyRead);
  await idleClosing;
  expect(getSqliteWorkerActorIdentity(peer.store)).toBe(first.actor);
  await expect(readContext(peerContext)).resolves.toEqual(emptyRead);

  expect(f.worker.threadId).not.toBe(-1);
  await maintenance.close();
  expect(f.worker.threadId).toBe(-1);
});

poolIt.each([undefined, "agent-resources", "shared-handles"] as const)(
  "joins a tracked maintenance callback before retiring its failed actor and idle co-user (during resource cleanup: %s)",
  async (duringCleanup) => {
    const { firstScope, firstContext, first, peer, worker } = await maintenancePair(
      "openclaw-worker-maintenance-drain-",
    );
    const gate = pause();
    let accepted: Promise<string> | undefined;
    const startAccepted = async () => {
      accepted = track(
        runOpenClawStateWorkerOperation(firstContext, async () => {
          await gate.wait();
          return "accepted callback completed";
        }),
      );
      await Promise.race([gate.entered, accepted]);
    };
    if (duringCleanup) {
      firstScope.own({}, duringCleanup, startAccepted);
    } else {
      await startAccepted();
    }
    const closed = vi.fn();
    const closing = track(firstScope.close().then(closed, closed));
    await Promise.race([
      gate.entered,
      closing.then(() => {
        throw new Error("Maintenance closed before its tracked callback entered");
      }),
    ]);
    await nextTurn();
    expect(closed).not.toHaveBeenCalled();
    expect(getSqliteWorkerActorIdentity(peer.store) === first.actor).toBe(true);

    await track(worker.terminate());
    expect(closed).not.toHaveBeenCalled();
    await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "unavailable" });
    gate.resume();
    await expect(accepted).resolves.toBe("accepted callback completed");
    await closing;
    // Observe the old client directly: a fresh shared-owner call could retire it itself.
    await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
  },
);

poolIt.each(["ordinary", "cleanup"] as const)(
  "reopens an idle failed actor through %s without waiting for its other maintenance client to close",
  async (entrypoint) => {
    const { firstContext, first, peer, worker } = await maintenancePair(
      "openclaw-worker-idle-reopen-",
    );
    await track(worker.terminate());
    await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "unavailable" });

    const reopened =
      entrypoint === "ordinary"
        ? (await openClient(firstContext)).store
        : await openCleanup(firstContext);
    if (!reopened) {
      throw new Error("Expected cleanup to retain the existing shared database");
    }
    if (entrypoint === "cleanup") {
      closers.push(() => reopened.close());
    }
    expect(getSqliteWorkerActorIdentity(reopened) === first.actor).toBe(false);
    await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
    if (entrypoint === "cleanup") {
      await reopened.close();
    }
    await expect(readContext(firstContext)).resolves.toEqual(emptyRead);
  },
);

function holdWorkerExit(worker: Worker) {
  const gate = pause();
  const exited = createDeferredCore();
  worker.once("exit", () => exited.resolve());
  const terminate = worker.terminate.bind(worker);
  let termination: Promise<number> | undefined;
  vi.spyOn(worker, "terminate").mockImplementation(
    () => (termination ??= track(gate.wait().then(terminate))),
  );
  return { ...gate, exited: exited.promise, finished: () => termination };
}

poolIt("joins adopted actor custody instead of its earlier per-client failure", async () => {
  const { firstScope, firstContext, peerContext, first, peer, worker } = await maintenancePair(
    "openclaw-worker-adopted-retirement-",
  );
  const gate = pause();
  const exit = holdWorkerExit(worker);
  const accepted = track(
    runOpenClawStateWorkerOperation(peerContext, async () => {
      await gate.wait();
      return "accepted callback completed";
    }),
  );
  await Promise.race([gate.entered, accepted]);

  // Exercise the broker's Worker-error boundary, keeping real native exit separately gated.
  const original = new Error("Synthetic actor failure before native exit");
  worker.emit("error", original);
  await exit.entered;
  await expect(peer.store.execute(read)).rejects.toMatchObject({
    code: "unavailable",
    message: original.message,
  });
  expect(worker.threadId).not.toBe(-1);

  // This first close releases its reference, then waits for the failed Worker's native exit.
  const firstClosing = track(firstScope.close());
  const firstOutcome = Promise.allSettled([firstClosing]);
  await expect(first.store.execute(read)).rejects.toMatchObject({ code: "closed" });
  await nextTurn();

  // The last tracked co-user starts actor retirement and adopts the pending first close.
  gate.resume();
  await expect(accepted).resolves.toBe("accepted callback completed");
  await expect(peer.store.execute(read)).rejects.toMatchObject({ code: "closed" });
  const canonicalClosing = track(
    closeOpenClawStateDatabaseByPathAsync(firstContext.admission.databasePath),
  );
  const canonicalSettled = vi.fn();
  const canonicalOutcome = canonicalClosing.then(canonicalSettled, canonicalSettled);
  await nextTurn();
  expect(canonicalSettled).not.toHaveBeenCalled();
  expect(worker.threadId).not.toBe(-1);

  exit.resume();
  await exit.finished();
  await exit.exited;
  await firstOutcome;
  await canonicalOutcome;
  expect(worker.threadId).toBe(-1);
  // Canonical close joins discharged custody without replaying the prior operation failure.
  await expect(canonicalClosing).resolves.toBeTypeOf("boolean");
});
