import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubChild } from "../supervisor/adapters/child.test-support.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("./cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cleanup.js")>()),
  terminateBrokerProcessGroup: () => ({ force: vi.fn(), settled: Promise.resolve() }),
}));

const children: ReturnType<typeof createStubChild>[] = [];
let host: SpawnBrokerHost | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  children.length = 0;
  native.spawn.mockReset().mockImplementation(() => {
    const child = createStubChild(41000 + children.length);
    // The broker inherits stdin and ignores output; it owns no piped stdio descriptors.
    Object.defineProperty(child.child, "stdio", { value: [null, null, null, null] });
    child.disconnectMock.mockImplementation(() => {
      Object.defineProperty(child.child, "connected", { value: false });
      child.child.emit("disconnect");
      child.emitExit(0);
      child.emitClose(0);
    });
    child.killMock.mockImplementation(() => {
      child.emitExit(1);
      child.emitClose(1);
      return true;
    });
    children.push(child);
    return child.child;
  });
});
afterEach(async () => {
  try {
    await host?.close();
  } finally {
    host = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

function currentChild() {
  return children.at(-1)!;
}
function markReady() {
  const { child } = currentChild();
  child.emit("message", { type: "ready", pid: child.pid });
}
function fail() {
  currentChild().emitExit(1);
  currentChild().emitClose(1);
}
function start() {
  const broker = createSpawnBrokerHost({
    workerUrl: new URL("./synthetic-spawn-broker.mjs", import.meta.url),
  });
  host = broker;
  markReady();
  return broker;
}

describe("spawn broker recovery budget", () => {
  it("recovers after more than five independently healthy generations", async () => {
    const broker = start();
    await broker.ready();
    for (let cycle = 0; cycle < 7; cycle++) {
      const previousPid = broker.pid;
      fail();
      const ready = broker.ready();
      await vi.advanceTimersToNextTimerAsync();
      expect(broker.pid).not.toBe(previousPid);
      markReady();
      await expect(ready).resolves.toBeUndefined();
    }
    expect(native.spawn).toHaveBeenCalledTimes(8);
  });

  it("stops after bounded consecutive recovery failures following a healthy startup", async () => {
    const broker = start();
    await broker.ready();
    fail();
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = expect(broker.ready()).rejects.toMatchObject({
        code: "ERR_SPAWN_BROKER_UNAVAILABLE",
      });
      await vi.advanceTimersToNextTimerAsync();
      fail();
      await failed;
    }
    // Exhaustion must leave no later generation queued, even beyond its backoff.
    await vi.advanceTimersToNextTimerAsync();
    expect(native.spawn).toHaveBeenCalledTimes(6);
    await broker.waitForCleanup();
    await expect(broker.ready()).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
  });
});
