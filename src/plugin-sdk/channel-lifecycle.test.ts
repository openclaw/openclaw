import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountStatusSink,
  keepHttpServerTaskAlive,
  runPassiveAccountLifecycle,
  waitUntilAbort,
} from "./channel-lifecycle.js";

type FakeServer = EventEmitter & {
  close: (callback?: () => void) => void;
};

function createFakeServer(): FakeServer {
  const server = new EventEmitter() as FakeServer;
  server.close = (callback) => {
    queueMicrotask(() => {
      server.emit("close");
      callback?.();
    });
  };
  return server;
}

describe("plugin-sdk channel lifecycle helpers", () => {
  it("binds account id onto status patches", () => {
    const setStatus = vi.fn();
    const statusSink = createAccountStatusSink({
      accountId: "default",
      setStatus,
    });

    statusSink({ running: true, lastStartAt: 123 });

    expect(setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      lastStartAt: 123,
    });
  });

  it("resolves waitUntilAbort when signal aborts", async () => {
    const abort = new AbortController();
    const task = waitUntilAbort(abort.signal);

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(early).toBe("pending");

    abort.abort();
    await expect(task).resolves.toBeUndefined();
  });

  it("runs abort cleanup before resolving", async () => {
    const abort = new AbortController();
    const onAbort = vi.fn(async () => undefined);

    const task = waitUntilAbort(abort.signal, onAbort);
    abort.abort();

    await expect(task).resolves.toBeUndefined();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("keeps passive account lifecycle pending until abort, then stops once", async () => {
    const abort = new AbortController();
    const stop = vi.fn();
    const task = runPassiveAccountLifecycle({
      abortSignal: abort.signal,
      start: async () => ({ stop }),
      stop: async (handle) => {
        handle.stop();
      },
    });

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(early).toBe("pending");
    expect(stop).not.toHaveBeenCalled();

    abort.abort();
    await expect(task).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps server task pending until close, then resolves", async () => {
    const server = createFakeServer();
    const task = keepHttpServerTaskAlive({ server });

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(early).toBe("pending");

    server.close();
    await expect(task).resolves.toBeUndefined();
  });

  it("triggers abort hook once and resolves after close", async () => {
    const server = createFakeServer();
    const abort = new AbortController();
    const onAbort = vi.fn(async () => {
      server.close();
    });

    const task = keepHttpServerTaskAlive({
      server,
      abortSignal: abort.signal,
      onAbort,
    });

    abort.abort();
    await expect(task).resolves.toBeUndefined();
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
