import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteReadOnlyNativeResourceClient } from "./sqlite-readonly-native-resource.client.js";
import { createNativeWorkerResource } from "./sqlite-readonly-native-resource.js";
import type {
  SqliteNativeOwnerReply,
  SqliteNativeOwnerRequest,
  SqliteNativeSessionLaunch,
} from "./sqlite-readonly-native-resource.types.js";
import { SqliteReadOnlyInspectionContentionError } from "./sqlite-readonly-worker-protocol.js";
import { createSqliteSnapshotStagingTokenSync } from "./sqlite-snapshot-staging.js";
import { captureSqliteStagingTokenIdentity } from "./sqlite-staging-token.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
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
  const hostPolicy = vi.fn(
    (_request: SqliteNativeOwnerRequest): void | { disposition: "retire" | "close" } => {},
  );
  hostPort.on("message", (request: SqliteNativeOwnerRequest) => {
    hostMessages.push(request);
    let reply: SqliteNativeOwnerReply;
    try {
      if (request.type === "allocated" || request.type === "token-reserved") {
        inventory.add(request.directory);
      } else if (!inventory.has(request.directory)) {
        throw new Error("Host received a directory outside this physical resource");
      }
      const decision = hostPolicy(request);
      if (request.type === "removed" || request.type === "token-settled") {
        inventory.delete(request.directory);
      }
      if (request.type === "token-disposition") {
        if (!decision) {
          throw new Error("Fixture token owner did not authorize settlement");
        }
        reply = { id: request.id, ok: true, disposition: decision.disposition };
      } else {
        reply = { id: request.id, ok: true };
      }
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

it.each([false, true])(
  "acknowledges a failed allocation as empty only with native not-started proof (%s)",
  async (notStarted) => {
    const { client, resource, launch, native, cleanup } = fixture();
    const failure = new Error("child exited before publishing its allocation");
    native.run.mockImplementationOnce(async () => {
      if (notStarted) {
        await native.close();
        native.notStarted = true;
      }
      throw failure;
    });
    const session = client.createSession(launch);
    await expect(
      session.run("/fixture/root", { mode: "staging-create", preparationId: 1 }),
    ).rejects.toThrow(failure.message);
    if (notStarted) {
      await expect(resource.close()).resolves.toBeUndefined();
    } else {
      cleanup.expectedFailure = /allocation has no exact directory receipt/;
      const closeFailure = await resource.close().catch((error: unknown) => error);
      expect(closeFailure).toBeInstanceOf(SqliteSnapshotCleanupError);
      expect(closeFailure).toHaveProperty("cause", failure);
      expect(native.close).toHaveBeenCalledOnce();
    }
    expect(operations.copy).not.toHaveBeenCalled();
    expect(operations.remove).not.toHaveBeenCalled();
  },
);

it.each(["missing-parent", "post-creation", "parent-busy"] as const)(
  "keeps real allocation custody truthful for %s failure through actual native close",
  async (phase) => {
    const entry = fixture();
    const actual = await vi.importActual<typeof import("./sqlite-readonly-worker.js")>(
      "./sqlite-readonly-worker.js",
    );
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const root = fs.realpathSync(tempDirs.make("native-allocation-receipt-"));
    const stagingRoot = path.join(root, "staging");
    fs.mkdirSync(stagingRoot);
    const marker = path.join(root, "creation-observed");
    const preload = path.join(root, "after-creation.cjs");
    if (phase === "post-creation") {
      fs.writeFileSync(
        preload,
        String.raw`
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "--openclaw-sqlite-readonly-child" && process.argv[3] === "session") {
  const original = fs.lstatSync;
  let injected = false;
  fs.lstatSync = function (...args) {
    const observed = Reflect.apply(original, this, args);
    const candidate = args[0];
    if (!injected && typeof candidate === "string" && observed.isDirectory() &&
        path.dirname(path.resolve(candidate)) === ${JSON.stringify(stagingRoot)} &&
        path.basename(candidate).startsWith("openclaw-sqlite-readonly-v2-")) {
      injected = true;
      fs.writeFileSync(${JSON.stringify(marker)}, "1");
      throw Object.assign(new Error("synthetic post-creation failure"), { code: "ENOENT" });
    }
    return observed;
  };
  require("node:module").syncBuiltinESMExports();
}
`,
      );
    }
    const sessions: Array<ReturnType<typeof actual.createScopedSqliteReadOnlyWorker>> = [];
    const order: string[] = [];
    const sessionCreated = createDeferredCore();
    const nativeFailure: { error?: unknown } = {};
    let restoreNativeRun: (() => void) | undefined;
    let releaseBlocker: (() => void) | undefined;
    operations.session.mockImplementation((launch) => {
      const native = actual.createScopedSqliteReadOnlyWorker(launch);
      sessions.push(native);
      if (phase === "parent-busy") {
        const originalRun = native.run.bind(native);
        const run = vi.spyOn(native, "run").mockImplementation((...args) => {
          const result = originalRun(...args);
          void result.catch((error: unknown) => {
            nativeFailure.error = error;
          });
          return result;
        });
        restoreNativeRun = () => run.mockRestore();
      }
      sessionCreated.resolve();
      void native.closed.then(() => {
        order.push("native-closed");
      });
      return native;
    });
    operations.copy.mockImplementation(actual.runSqliteReadOnlyWorkerOnce);
    operations.remove.mockImplementation(actualFs.rm);
    entry.closeNative = async () => {
      for (const native of sessions) {
        await native.close();
        await native.closed;
      }
    };
    const launch: SqliteNativeSessionLaunch = {
      ...entry.launch,
      cwd: root,
      env: {
        ...entry.launch.env,
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        ...(phase === "post-creation" ? sqliteWorkerPreloadEnv(preload) : {}),
      },
    };
    const session = entry.client.createSession(launch);
    try {
      let allocationRoot =
        phase === "missing-parent" ? path.join(stagingRoot, "missing") : stagingRoot;
      if (phase === "parent-busy") {
        const parent = createSqliteSnapshotStagingTokenSync(stagingRoot);
        parent.release();
        const blocker = new (requireNodeSqlite().DatabaseSync)(
          path.join(parent.directory, "owner.sqlite"),
        );
        releaseBlocker = () => {
          try {
            if (blocker.isOpen && blocker.isTransaction) {
              blocker.exec("ROLLBACK");
            }
          } finally {
            if (blocker.isOpen) {
              blocker.close();
            }
          }
        };
        await sessionCreated.promise;
        allocationRoot = parent.directory;
        // All host filesystem setup precedes this lock; keep the same handle until child close.
        blocker.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      }
      const failure = await session
        .run(allocationRoot, {
          mode: "staging-create",
          preparationId: 1,
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) {
        throw new Error("Expected original native allocation failure");
      }
      if (phase === "parent-busy") {
        expect(failure.message).toMatch(/locked|busy/i);
      } else if (phase === "missing-parent") {
        expect(failure.message).toContain("ENOENT");
        expect(failure.message).toContain("snapshot staging root");
        expect(failure.message).toContain("check filesystem health and write permissions");
      } else {
        expect(failure.message).toContain("ENOENT");
        expect(failure.message).toContain("synthetic post-creation failure");
        expect(fs.readFileSync(marker, "utf8")).toBe("1");
      }
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.notStarted).toBe(false);
      expect(order).toEqual([]);
      const outcome = await entry.resource.close().then(
        () => {
          order.push("resource-closed");
          return { status: "fulfilled" } as const;
        },
        (error: unknown) => {
          order.push("resource-rejected");
          entry.cleanup.expectedFailure = /allocation has no exact directory receipt/;
          return { status: "rejected", error } as const;
        },
      );
      if (phase === "parent-busy") {
        expect(nativeFailure.error).toBeInstanceOf(SqliteReadOnlyInspectionContentionError);
      }
      if (phase !== "post-creation") {
        expect(outcome.status).toBe("fulfilled");
        expect(order).toEqual(["native-closed", "resource-closed"]);
      } else {
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("Post-creation failure must retain unresolved allocation custody");
        }
        expect(outcome.error).toBeInstanceOf(SqliteSnapshotCleanupError);
        expect(outcome.error).toMatchObject({
          cause: expect.objectContaining({
            message: expect.stringContaining("synthetic post-creation failure"),
          }),
        });
        expect(order).toEqual(["native-closed", "resource-rejected"]);
      }
      expect(entry.inventory.size).toBe(0);
      expect(operations.session.mock.calls.length).toBe(1);
      expect(operations.copy.mock.calls.length).toBe(0);
      expect(operations.remove.mock.calls.length).toBe(0);
    } finally {
      try {
        await entry.closeNative();
      } finally {
        try {
          releaseBlocker?.();
        } finally {
          restoreNativeRun?.();
        }
      }
    }
  },
);

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

it.each([false, true])(
  "closes independent native snapshots while a token owner refuses settlement (remove fails: %s)",
  async (removalFails) => {
    const { client, resource, hostPolicy, inventory, hostMessages } = fixture();
    const actual = await vi.importActual<typeof import("./sqlite-readonly-worker.js")>(
      "./sqlite-readonly-worker.js",
    );
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const nativeSessions: Array<{
      native: ReturnType<typeof actual.createScopedSqliteReadOnlyWorker>;
      joined: boolean;
    }> = [];
    operations.session.mockImplementation((launch) => {
      const native = actual.createScopedSqliteReadOnlyWorker(launch);
      const entry = { native, joined: false };
      nativeSessions.push(entry);
      void native.closed.then(() => {
        entry.joined = true;
      });
      return native;
    });
    operations.copy.mockImplementation(actual.runSqliteReadOnlyWorkerOnce);
    operations.remove.mockImplementation(actualFs.rm);
    const root = fs.realpathSync(tempDirs.make("native-independent-cleanup-"));
    const tokenDirectory = path.join(root, "plugin-token");
    fs.mkdirSync(tokenDirectory);
    const identity = captureSqliteStagingTokenIdentity(tokenDirectory, "create");
    const launch: SqliteNativeSessionLaunch = {
      ...actual.captureSqliteReadOnlyWorkerLaunch(),
      transport: { kind: "native" },
      retainLifetime: false,
      retainOnOperationError: true,
    };
    let tokenReleased = false;
    const refusal = new SqliteSnapshotCleanupError("plugin still owns its original token");
    hostPolicy.mockImplementation((request) => {
      if (request.type === "token-disposition") {
        if (!tokenReleased) {
          throw refusal;
        }
        return { disposition: "close" };
      }
      return undefined;
    });
    const sqlite = requireNodeSqlite();
    const failures: unknown[] = [];
    try {
      const token = client.createSession(launch, {
        directory: tokenDirectory,
        mode: "create",
        preparationId: 1,
        identity,
      });
      expect(
        await token.run(tokenDirectory, { mode: "token-create", preparationId: 1, identity }),
      ).toEqual(identity);
      const snapshot = client.createSession(launch);
      const directory = await snapshot.run(root, { mode: "staging-create", preparationId: 2 });
      const database = new sqlite.DatabaseSync(path.join(directory, "database.sqlite"));
      try {
        database.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('snapshot');");
      } finally {
        database.close();
      }
      expect(nativeSessions.length).toBe(2);
      const [tokenSession, snapshotSession] = nativeSessions;
      if (!tokenSession || !snapshotSession) {
        throw new Error("Expected the original token and snapshot native sessions");
      }
      const removalFailure = Object.assign(new Error("snapshot removal refused"), {
        code: "EACCES",
      });
      if (removalFails) {
        operations.remove.mockRejectedValueOnce(removalFailure);
      }
      const result = await resource.close().then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("Resource closed while its original token owner still refused settlement");
      }
      if (removalFails) {
        expect(result.error instanceof AggregateError).toBe(true);
        if (!(result.error instanceof AggregateError)) {
          throw new Error("Independent cleanup failures lost their aggregate");
        }
        expect(result.error.errors.length).toBe(2);
        const primary: unknown = result.error.errors[0];
        expect(primary instanceof Error && primary.message === refusal.message).toBe(true);
        expect(result.error.errors[1] === removalFailure).toBe(true);
        expect(result.error.cause === primary).toBe(true);
      } else {
        expect(result.error instanceof Error && result.error.message === refusal.message).toBe(
          true,
        );
      }
      expect(tokenSession.joined).toBe(false);
      expect(snapshotSession.joined).toBe(true);
      expect(fs.existsSync(directory)).toBe(removalFails);
      expect(inventory.has(directory)).toBe(removalFails);
      expect(inventory.has(tokenDirectory)).toBe(true);
      expect(hostMessages.some((request) => request.type === "token-settled")).toBe(false);
      const probe = new sqlite.DatabaseSync(path.join(tokenDirectory, "owner.sqlite"), {
        timeout: 0,
      });
      try {
        expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      } finally {
        if (probe.isTransaction) {
          probe.exec("ROLLBACK");
        }
        probe.close();
      }
      tokenReleased = true;
      await resource.close();
      expect(nativeSessions.every((entry) => entry.joined)).toBe(true);
      expect(inventory.size).toBe(0);
      expect(fs.existsSync(directory)).toBe(false);
      expect(fs.existsSync(tokenDirectory)).toBe(true);
      const released = new sqlite.DatabaseSync(path.join(tokenDirectory, "owner.sqlite"), {
        timeout: 0,
      });
      try {
        expect(released.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
        released.exec("BEGIN IMMEDIATE");
        released.exec("ROLLBACK");
      } finally {
        released.close();
      }
      expect(operations.session.mock.calls.length).toBe(2);
    } catch (error) {
      failures.push(error);
    }
    tokenReleased = true;
    operations.remove.mockReset().mockImplementation(actualFs.rm);
    try {
      await resource.close();
      await Promise.all(nativeSessions.map((entry) => entry.native.closed));
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Independent native cleanup fixture failed", {
        cause: failures[0],
      });
    }
  },
);
