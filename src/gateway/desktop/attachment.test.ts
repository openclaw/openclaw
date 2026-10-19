import { once } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { connectRfbAttachment } from "./attachment.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const { cleanupWarning } = vi.hoisted(() => ({ cleanupWarning: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: cleanupWarning }),
}));

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const tcpAttachment = { kind: "tcp", host: "127.0.0.1", port: 5900 } as const;
type Registry = ReturnType<typeof createDesktopSessionRegistry>;
let registry: Registry;
const start = vi.fn(async () => ({ attachment: tcpAttachment }));
const teardown = vi.fn(async () => {});
const dispose = vi.fn(async () => {});
beforeEach(() => {
  registry = createDesktopSessionRegistry();
  start.mockClear();
  teardown.mockReset().mockResolvedValue(undefined);
  dispose.mockReset().mockResolvedValue(undefined);
  cleanupWarning.mockClear();
});
function request(overrides: Partial<Parameters<Registry["acquire"]>[0]> = {}) {
  return {
    sourceKey: "node:one",
    ownerEpoch: 1,
    start,
    ...overrides,
  };
}

function holdTeardown() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  teardown.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered, release };
}

function createPendingStream(owner: Registry) {
  return owner.createStream({ sourceKey: "node:one", ownerEpoch: 1, onStopped: () => {} });
}

function observe(owner: Registry, close = () => {}) {
  return owner.attachObserver("node:one", { ownerEpoch: 1, control: false, close });
}

afterEach(async () => {
  vi.useRealTimers();
  await registry.stopAll();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

it("connects a loopback TCP attachment", async () => {
  const server = net.createServer((socket) => sockets.push(socket));
  servers.push(server);
  const accepted = once(server, "connection").then(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }

  sockets.push(connectRfbAttachment({ kind: "tcp", host: "127.0.0.1", port: address.port }));

  await expect(accepted).resolves.toBeUndefined();
});

it.each([false, true])("claims only its source's live stream (closed: %s)", async (closed) => {
  await registry.acquire(request());
  await registry.activate({ sourceKey: "node:two", ownerEpoch: 1 });
  const stream = new PassThrough();
  const pending = createPendingStream(registry);
  expect(pending.reserve()).toBe(true);
  const invocation = createDeferredCore<{ error?: { message?: string } }>();
  await pending.connect(
    { attached: Promise.resolve({ stream }), cancel: () => {} },
    () => invocation.promise,
  );
  const attachment = pending.publish();
  if (!attachment) {
    throw new Error("expected stream attachment");
  }
  try {
    expect(registry.claimStream("node:two", attachment)).toBeUndefined();
    expect(stream.destroyed).toBe(false);
    expect(registry.hasActivity("node:one", 1)).toBe(true);

    if (closed) {
      const streamClosed = once(stream, "close");
      stream.destroy();
      await streamClosed;
    }

    expect(registry.claimStream("node:one", attachment)).toBe(closed ? undefined : stream);
    expect(registry.hasActivity("node:one", 1)).toBe(false);
    expect(registry.claimStream("node:one", attachment)).toBeUndefined();
  } finally {
    stream.destroy();
    invocation.resolve({});
    await pending.stop();
  }
});

it.each(["acquire", "activate"] as const)("refreshes idle cleanup after %s", async (method) => {
  vi.useFakeTimers();
  registry = createDesktopSessionRegistry();
  const params = request({ teardown });
  await registry[method](params);
  await vi.advanceTimersByTimeAsync(48_000);
  await registry[method](params);
  await vi.advanceTimersByTimeAsync(48_000);
  expect(teardown).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(12_000);
  expect(teardown).toHaveBeenCalled();
});

it.each(["stop", "stopAll"] as const)("%s joins teardown already in progress", async (method) => {
  const { entered, release } = holdTeardown();
  await registry.activate(request({ teardown }));
  const completed: string[] = [];
  let reentrantStop: Promise<void> | undefined;
  observe(registry, () => {
    reentrantStop = registry.stop("node:one", 1).then(() => {
      completed.push("observer");
    });
  });
  const first = registry.stop("node:one", 1);
  await entered.promise;
  const second = (method === "stop" ? registry.stop("node:one", 1) : registry.stopAll()).then(
    () => {
      completed.push("second");
    },
  );
  try {
    await setImmediate();
    expect(completed).toEqual([]);
    expect(reentrantStop).toBeDefined();
    expect(createPendingStream(registry).reserve()).toBe(false);
  } finally {
    release.resolve();
    await Promise.all([first, second, reentrantStop]);
  }
  expect(completed.toSorted()).toEqual(["observer", "second"]);
});

it.each([1, 2])("waits for stopped resources before acquiring epoch %s", async (ownerEpoch) => {
  const { entered, release } = holdTeardown();
  await registry.acquire(request({ teardown }));
  const stopping = registry.stop("node:one", 1);
  await entered.promise;
  start.mockClear();
  const acquiring = registry.acquire({ sourceKey: "node:one", ownerEpoch, start });
  try {
    await setImmediate();
    expect(start).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.all([stopping, acquiring]);
  }
  expect(start).toHaveBeenCalledOnce();
});

it("bounds pending observer reservations before streams are started", async () => {
  await registry.activate(request());
  const pending = Array.from({ length: 8 }, () => createPendingStream(registry));
  expect(pending.every((stream) => stream.reserve())).toBe(true);
  expect(createPendingStream(registry).reserve()).toBe(false);

  await pending[0]?.stop();
  expect(createPendingStream(registry).reserve()).toBe(true);
});

it.each([1, 2])("bounds repeated failed cleanup at epoch %s", async (ownerEpoch) => {
  const failure = new Error("transport still running");
  teardown.mockRejectedValue(failure);
  const params = request({ start, teardown, dispose });
  await registry.acquire(params);
  try {
    if (ownerEpoch === 1) {
      await expect(registry.stop("node:one", 1)).rejects.toBe(failure);
    }
    for (let attempt = 1; attempt < 300; attempt++) {
      await expect(registry.acquire({ ...params, ownerEpoch })).rejects.toBe(failure);
    }
    expect(teardown).toHaveBeenCalledOnce();
    expect(cleanupWarning).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(createPendingStream(registry).reserve()).toBe(false);
  } finally {
    teardown.mockClear();
    teardown.mockResolvedValue(undefined);
    await registry.stopAll();
  }
  // Only the original owner remains to recover, with teardown bracketing initialization.
  expect(teardown).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledOnce();
  await registry.acquire({ ...params, ownerEpoch: 2 });
  expect(start).toHaveBeenCalledTimes(2);
});

it.each(["epoch", "source", "all"] as const)(
  "keeps a draining replacement visible to %s stop",
  async (scope) => {
    const { entered, release } = holdTeardown();
    await registry.activate(request({ teardown }));
    const acquiring = registry.acquire({ sourceKey: "node:one", ownerEpoch: 2, start });
    const outcome = acquiring.then(
      () => "ready",
      () => "stopped",
    );
    await entered.promise;
    const stopping =
      scope === "all"
        ? registry.stopAll()
        : registry.stop("node:one", scope === "epoch" ? 2 : undefined);
    release.resolve();
    await stopping;
    expect(await outcome).toBe("stopped");
    expect(start).not.toHaveBeenCalled();
  },
);

it("joins sibling teardown before reporting stopAll failure", async () => {
  const release = createDeferredCore();
  const failure = new Error("cleanup failed");
  teardown.mockRejectedValue(failure);
  await registry.activate(request({ teardown }));
  await registry.activate(request({ sourceKey: "node:two", teardown: () => release.promise }));
  let settled = false;
  const stopping = registry.stopAll().finally(() => {
    settled = true;
  });
  const rejected = expect(stopping).rejects.toBe(failure);
  try {
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    await rejected;
    teardown.mockResolvedValue(undefined);
  }
});

it("retains failed resource disposal for a later cleanup retry", async () => {
  const failure = new Error("directory still present");
  dispose.mockRejectedValueOnce(failure);
  await registry.activate(request({ dispose }));
  await expect(registry.stop("node:one", 1)).rejects.toBe(failure);
  await registry.stopAll();
  expect(dispose).toHaveBeenCalledTimes(2);
});

it("does not linger-stop a reservation when another observer disconnects", async () => {
  vi.useFakeTimers();
  registry = createDesktopSessionRegistry();
  await registry.activate(request({ teardown }));
  const observer = observe(registry);
  const pending = createPendingStream(registry);
  expect(pending.reserve()).toBe(true);
  expect(observer).toBeDefined();
  observer?.release();
  await vi.advanceTimersByTimeAsync(240_000);
  expect(teardown).not.toHaveBeenCalled();

  await pending.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(teardown).toHaveBeenCalled();
});
