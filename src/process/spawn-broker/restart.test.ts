import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

let child: ReturnType<typeof createStubChild>;
let host: SpawnBrokerHost;
const workerUrl = new URL("synthetic-spawn-broker.mjs", import.meta.url);
beforeEach(async () => {
  vi.useFakeTimers();
  native.spawn.mockReset().mockImplementation(() => {
    child = createStubChild(40999 + native.spawn.mock.calls.length);
    const current = child;
    // The broker inherits stdin and ignores output; it owns no piped stdio descriptors.
    Object.defineProperty(current.child, "stdio", { value: [null, null, null, null] });
    current.disconnectMock.mockImplementation(() => retire(current, 0));
    return current.child;
  });
  host = createSpawnBrokerHost({ workerUrl });
  markReady();
  await host.ready();
});
afterEach(async () => {
  try {
    await host.close();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

function markReady() {
  child.child.emit("message", { type: "ready", pid: child.child.pid });
}
function retire(current: typeof child, code: number) {
  Object.defineProperty(current.child, "connected", { value: false });
  current.child.emit("disconnect");
  current.emitExit(code);
  current.emitClose(code);
}
it("recovers after more than five independently healthy generations", async () => {
  for (let cycle = 0; cycle < 7; cycle++) {
    const previousPid = host.pid;
    retire(child, 1);
    const ready = host.ready();
    await vi.advanceTimersToNextTimerAsync();
    expect(host.pid).not.toBe(previousPid);
    markReady();
    await expect(ready).resolves.toBeUndefined();
  }
  expect(native.spawn).toHaveBeenCalledTimes(8);
});

it("stops after bounded consecutive recovery failures following a healthy startup", async () => {
  retire(child, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const failed = expect(host.ready()).rejects.toMatchObject({
      code: "ERR_SPAWN_BROKER_UNAVAILABLE",
    });
    await vi.advanceTimersToNextTimerAsync();
    retire(child, 1);
    await failed;
  }
  // Exhaustion must leave no later generation queued, even beyond its backoff.
  await vi.advanceTimersToNextTimerAsync();
  expect(native.spawn).toHaveBeenCalledTimes(6);
  await host.waitForCleanup();
  await expect(host.ready()).rejects.toMatchObject({ code: "ERR_SPAWN_BROKER_UNAVAILABLE" });
});
