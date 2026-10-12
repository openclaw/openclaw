import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceClient } from "./sqlite-readonly-native-resource.client.js";
import { createNativeWorkerResource } from "./sqlite-readonly-native-resource.js";
import type {
  SqliteNativeOwnerReply,
  SqliteNativeOwnerRequest,
  SqliteNativeSessionLaunch,
} from "./sqlite-readonly-native-resource.types.js";
import type { NativeWorkerResourceOwner } from "./worker-native-lifecycle.types.js";

const operations = vi.hoisted(() => ({
  session: vi.fn<typeof import("./sqlite-readonly-worker.js").createScopedSqliteReadOnlyWorker>(),
  copy: vi.fn<typeof import("./sqlite-readonly-worker.js").runSqliteReadOnlyWorkerOnce>(),
  remove: vi.fn<typeof import("node:fs/promises").rm>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, rm: operations.remove }, rm: operations.remove };
});
vi.mock("./sqlite-readonly-worker.js", () => ({
  createScopedSqliteReadOnlyWorker: operations.session,
  runSqliteReadOnlyWorkerOnce: operations.copy,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const owned: Array<{
  resource: NativeWorkerResourceOwner;
  port1: MessagePort;
  port2: MessagePort;
  ownerPort: MessagePort;
  hostPort: MessagePort;
  cleanup: { expectedFailure?: RegExp };
  closeNative(): Promise<void>;
}> = [];
function fixture() {
  const closed = createDeferredCore();
  let retired = false;
  const native = {
    closed: closed.promise,
    notStarted: false,
    isRetired: () => retired,
    compatible: () => !retired,
    createNativeReplacement() {
      throw new Error("Native resource must not replace its session");
    },
    run: vi.fn(async (pathname: string) => pathname),
    close: vi.fn(async () => {
      retired = true;
      closed.resolve();
      await closed.promise;
    }),
  };
  operations.session.mockReset().mockReturnValue(native);
  operations.copy.mockReset().mockImplementation(async (pathname) => pathname);
  operations.remove.mockReset().mockResolvedValue(undefined);
  const { port1, port2 } = new MessageChannel();
  const { port1: ownerPort, port2: hostPort } = new MessageChannel();
  // This is the host policy boundary, not physical filesystem or process proof.
  const inventory = new Set<string>();
  const hostMessages: SqliteNativeOwnerRequest[] = [];
  const hostPolicy = vi.fn((_request: SqliteNativeOwnerRequest) => {});
  hostPort.on("message", (request: SqliteNativeOwnerRequest) => {
    hostMessages.push(request);
    let reply: SqliteNativeOwnerReply;
    try {
      if (request.type === "allocated") {
        inventory.add(request.directory);
      } else if (!inventory.has(request.directory)) {
        throw new Error("Host received a directory outside this physical resource");
      }
      hostPolicy(request);
      if (request.type === "removed") {
        inventory.delete(request.directory);
      }
      reply = { id: request.id, ok: true };
    } catch (error: unknown) {
      const encoded = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
      if (!encoded) {
        throw new Error("Fixture host failure must be an Error", { cause: error });
      }
      reply = { id: request.id, ok: false, error: encoded };
    }
    hostPort.postMessage(reply, { transfer: [] });
  });
  const resource = createNativeWorkerResource(port1, undefined, ownerPort);
  const client = createSqliteReadOnlyNativeResourceClient(port2);
  const launch: SqliteNativeSessionLaunch = {
    env: { FIXTURE: "captured" },
    cwd: process.cwd(),
    transport: { kind: "native" },
    retainLifetime: false,
    retainOnOperationError: true,
  };
  const cleanup: { expectedFailure?: RegExp } = {};
  const closeNative: () => Promise<void> = native.close;
  const value = {
    resource,
    client,
    launch,
    native,
    closed,
    port1,
    port2,
    ownerPort,
    hostPort,
    inventory,
    hostMessages,
    hostPolicy,
    cleanup,
    closeNative,
  };
  owned.push(value);
  return value;
}
afterEach(async () => {
  for (const entry of owned.splice(0)) {
    try {
      if (entry.cleanup.expectedFailure) {
        await expect(entry.resource.close()).rejects.toThrow(entry.cleanup.expectedFailure);
        // Join the fixture's original producer after the resource refuses
        // to acknowledge unresolved cleanup; physical cases install their real close.
        await entry.closeNative();
      } else {
        await entry.resource.close();
      }
    } finally {
      entry.port1.close();
      entry.port2.close();
      entry.ownerPort.close();
      entry.hostPort.close();
    }
  }
});

it("projects an accepted allocation before closing its child after target port loss", async () => {
  const { client, resource, launch, native, port2, inventory, hostMessages } = fixture();
  const entered = createDeferredCore();
  const complete = createDeferredCore<string>();
  native.run.mockImplementationOnce(async () => {
    entered.resolve();
    return await complete.promise;
  });
  const session = client.createSession(launch);
  const allocation = session.run("/fixture/root", { mode: "staging-create", preparationId: 1 });
  const rejected = expect(allocation).rejects.toThrow("child cleanup is not acknowledged");
  await entered.promise;
  port2.close();
  await rejected;
  const closing = resource.close();
  const joined = expect(closing).resolves.toBeUndefined();
  try {
    await nextTurn();
    expect(native.close).not.toHaveBeenCalled();
    expect(operations.copy).not.toHaveBeenCalled();
    expect(hostMessages).toEqual([]);
  } finally {
    complete.resolve("/fixture/allocated-before-reply");
    await joined;
  }
  expect(hostMessages.map(({ id: _id, ...request }) => request)).toEqual([
    { type: "allocated", directory: "/fixture/allocated-before-reply", preparationId: 1 },
    { type: "retire", directory: "/fixture/allocated-before-reply" },
    { type: "removed", directory: "/fixture/allocated-before-reply" },
  ]);
  expect(native.close).toHaveBeenCalledOnce();
  expect(operations.copy).toHaveBeenCalledWith(
    "/fixture/allocated-before-reply",
    { mode: "staging-reconcile" },
    { env: launch.env, cwd: launch.cwd, deadlineOwnedByCaller: false },
  );
  expect(operations.remove).toHaveBeenCalledWith("/fixture/allocated-before-reply", {
    force: true,
    recursive: true,
    maxRetries: 3,
    retryDelay: 20,
  });
  expect(inventory.size).toBe(0);
});

it("retains creator custody behind a host reader fence and retries cleanup on the same resource", async () => {
  const { client, resource, launch, native, hostPolicy, inventory } = fixture();
  const session = client.createSession(launch);
  await session.run("/fixture/fenced", { mode: "staging-create", preparationId: 1 });
  let readerActive = true;
  hostPolicy.mockImplementation((request) => {
    if (request.type === "retire" && readerActive) {
      throw new SqliteSnapshotCleanupError("snapshot still belongs to an active reader");
    }
  });
  try {
    await expect(resource.close()).rejects.toThrow("active reader");
    expect(native.close).not.toHaveBeenCalled();
    expect(operations.copy).not.toHaveBeenCalled();
    expect(operations.remove).not.toHaveBeenCalled();
    expect(inventory).toEqual(new Set(["/fixture/fenced"]));
  } finally {
    readerActive = false;
    await resource.close();
  }
  expect(operations.session).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalledOnce();
  expect(operations.copy).toHaveBeenCalledWith(
    "/fixture/fenced",
    { mode: "staging-reconcile" },
    { env: launch.env, cwd: launch.cwd, deadlineOwnedByCaller: false },
  );
  expect(inventory.size).toBe(0);
});

it("refuses cleanup after losing its host fence port without releasing creator custody", async () => {
  const { client, resource, launch, native, hostPort, ownerPort, cleanup } = fixture();
  const session = client.createSession(launch);
  await session.run("/fixture/host-lost", { mode: "staging-create", preparationId: 1 });
  const disconnected = new Promise<void>((resolve) => {
    ownerPort.once("close", resolve);
  });
  cleanup.expectedFailure = /host cleanup owner is unavailable/;
  hostPort.close();
  await disconnected;
  await expect(resource.close()).rejects.toThrow(cleanup.expectedFailure);
  expect(native.close).not.toHaveBeenCalled();
  expect(operations.copy).not.toHaveBeenCalled();
  expect(operations.remove).not.toHaveBeenCalled();
});

it("closes the real native session after a refused allocation", async () => {
  const entry = fixture();
  const actual = await vi.importActual<typeof import("./sqlite-readonly-worker.js")>(
    "./sqlite-readonly-worker.js",
  );
  const root = fs.realpathSync(tempDirs.make("native-allocation-receipt-"));
  const launch: SqliteNativeSessionLaunch = {
    ...entry.launch,
    cwd: root,
    env: { ...entry.launch.env, PATH: process.env.PATH, HOME: root, TMPDIR: root },
  };
  const sessions: Array<ReturnType<typeof actual.createScopedSqliteReadOnlyWorker>> = [];
  let nativeClosed = false;
  operations.session.mockImplementation((nativeLaunch) => {
    const native = actual.createScopedSqliteReadOnlyWorker(nativeLaunch);
    sessions.push(native);
    void native.closed.then(() => {
      nativeClosed = true;
    });
    return native;
  });
  entry.closeNative = async () => {
    for (const native of sessions) {
      await native.close();
      await native.closed;
    }
  };
  const session = entry.client.createSession(launch);
  await expect(
    session.run(path.join(root, "missing"), { mode: "staging-create", preparationId: 1 }),
  ).rejects.toThrow("snapshot staging root");
  await entry.resource.close();
  expect(nativeClosed).toBe(true);
  expect(sessions).toHaveLength(1);
  expect(entry.inventory.size).toBe(0);
  expect(operations.copy).not.toHaveBeenCalled();
  expect(operations.remove).not.toHaveBeenCalled();
});

it("creates native sessions only through RPC and preserves captured launch and staging commands", async () => {
  const { client, launch, native, closed, inventory, resource } = fixture();
  expect(operations.session).not.toHaveBeenCalled();
  const session = client.createSession(launch);
  expect(operations.session).not.toHaveBeenCalled();
  launch.env.FIXTURE = "changed";
  expect(
    await session.run("/fixture/staging", { mode: "staging-create-legacy", preparationId: 1 }),
  ).toBe("/fixture/staging");
  expect(operations.session).toHaveBeenCalledWith({ ...launch, env: { FIXTURE: "captured" } });
  expect(native.run).toHaveBeenCalledWith("/fixture/staging", { mode: "staging-create-legacy" });
  expect(session.compatible(launch)).toBe(false);
  expect(session.compatible({ ...launch, env: { FIXTURE: "captured" } })).toBe(true);
  expect(session.isRetired()).toBe(false);
  closed.resolve();
  await nextTurn();
  expect(session.isRetired()).toBe(true);
  await session.close();
  await session.close();
  expect(native.close).toHaveBeenCalledOnce();
  expect(inventory).toEqual(new Set(["/fixture/staging"]));
  await client.removed("/fixture/staging");
  expect(inventory.size).toBe(0);
  await resource.close();
  expect(operations.copy).not.toHaveBeenCalled();
  expect(operations.remove).not.toHaveBeenCalled();
});

it("joins a cancelled copy without aborting another copy or the token session", async () => {
  const { client, launch, native } = fixture();
  const session = client.createSession(launch);
  await session.run("/fixture/token", { mode: "staging-create", preparationId: 1 });
  const entered = createDeferredCore();
  const cancelled = createDeferredCore();
  const gates = [createDeferredCore(), createDeferredCore()];
  const signals: AbortSignal[] = [];
  operations.copy.mockImplementation(async (pathname, options) => {
    if (!options.signal) {
      throw new Error("Copy must have independent cancellation");
    }
    const index = signals.length;
    signals.push(options.signal);
    if (index === 0) {
      options.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    }
    if (signals.length === 2) {
      entered.resolve();
    }
    await gates[index]!.promise;
    options.signal.throwIfAborted();
    return pathname;
  });
  const controller = new AbortController();
  const reason = new Error("first caller stopped");
  const copyLaunch = { env: launch.env, cwd: launch.cwd, deadlineOwnedByCaller: true };
  const first = client.runOnce(
    "first",
    { mode: "sync", stagingRoot: "/fixture/one", signal: controller.signal },
    copyLaunch,
  );
  const second = client.runOnce(
    "second",
    { mode: "async", stagingRoot: "/fixture/two" },
    copyLaunch,
  );
  const rejected = expect(first).rejects.toBe(reason);
  let settled = false;
  void first.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await entered.promise;
    controller.abort(reason);
    await cancelled.promise;
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(settled).toBe(false);
    expect(native.close).not.toHaveBeenCalled();
    gates[0]!.resolve();
    await rejected;
    gates[1]!.resolve();
    expect(await second).toBe("second");
    expect(await session.run("/fixture/token", { mode: "staging-retire" })).toBe("/fixture/token");
    expect(operations.copy.mock.calls.map((call) => call[2])).toEqual([copyLaunch, copyLaunch]);
  } finally {
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([first, second]);
    await session.close();
    await client.removed("/fixture/token");
  }
});

it("preserves expected operation errors without retiring the surviving native session", async () => {
  const { client, launch, native } = fixture();
  const session = client.createSession(launch);
  const cause = new Error("token remained busy");
  native.run.mockRejectedValueOnce(new AggregateError([cause], "retirement refused", { cause }));
  const failure = await session
    .run("/fixture/token", { mode: "staging-retire" })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) {
    throw new Error("Native error graph was not retained");
  }
  expect(failure.errors).toEqual([expect.objectContaining({ message: cause.message })]);
  expect(failure.cause).toBe(failure.errors[0]);
  expect(session.isRetired()).toBe(false);
  expect(session.compatible(launch)).toBe(true);
  expect(await session.run("/fixture/token", { mode: "staging-retire" })).toBe("/fixture/token");
  await session.close();
});

it("seals creation and retries a failed close on the same native session", async () => {
  const { client, resource, launch, native } = fixture();
  const session = client.createSession(launch);
  await session.run("/fixture/token", { mode: "staging-create", preparationId: 1 });
  const failure = new Error("native close was not acknowledged");
  native.close.mockRejectedValueOnce(failure);
  await expect(resource.close()).rejects.toBe(failure);
  const refused = client.createSession(launch);
  await expect(
    refused.run("/fixture/other", { mode: "staging-create", preparationId: 1 }),
  ).rejects.toThrow("closing");
  expect(operations.session).toHaveBeenCalledOnce();
  await resource.close();
  expect(native.close).toHaveBeenCalledTimes(2);
});

it("settles a refused native creation before a later session can allocate", async () => {
  const { client, launch } = fixture();
  const failure = new Error("native launch refused before creating a child");
  operations.session.mockImplementationOnce(() => {
    throw failure;
  });
  const refused = client.createSession(launch);
  await expect(
    refused.run("/fixture/first", { mode: "staging-create", preparationId: 1 }),
  ).rejects.toThrow(failure.message);
  await expect(refused.close()).resolves.toBeUndefined();
  const next = client.createSession(launch);
  expect(await next.run("/fixture/second", { mode: "staging-create", preparationId: 1 })).toBe(
    "/fixture/second",
  );
  await next.close();
});

it("rejects lost-port RPCs without declaring child death and joins outstanding work on owner close", async () => {
  const { client, resource, launch, native, port2 } = fixture();
  const session = client.createSession(launch);
  await session.run("/fixture/token", { mode: "staging-create", preparationId: 1 });
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  let signal: AbortSignal | undefined;
  operations.copy.mockImplementation(async (_pathname, options) => {
    signal = options.signal;
    entered.resolve();
    await finish.promise;
    signal?.throwIfAborted();
    return "/fixture/copy";
  });
  const copy = client.runOnce(
    "/fixture/source",
    { mode: "sync" },
    {
      env: launch.env,
      cwd: launch.cwd,
      deadlineOwnedByCaller: false,
    },
  );
  const rejected = expect(copy).rejects.toThrow("child cleanup is not acknowledged");
  await entered.promise;
  port2.close();
  await rejected;
  expect(session.isRetired()).toBe(false);
  let joined = false;
  const closing = resource.close().then(() => {
    joined = true;
  });
  try {
    await nextTurn();
    expect(signal?.aborted).toBe(true);
    expect(joined).toBe(false);
    expect(native.close).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await closing;
  }
  expect(native.close).toHaveBeenCalledOnce();
});
