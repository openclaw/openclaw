import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { relayDefaults, relayPeer } from "./service-child-relay-host.fixture.test-support.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createWritableRelayChild } from "./service-child-relay-host.test-support.js";
import type { ProcessExtinctionResult } from "./types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), delay: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../utils/sleep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/sleep.js")>()),
  sleep: mocks.delay,
}));
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each([
  { rootObserved: false, fault: "close" },
  { rootObserved: true, fault: "close" },
  { rootObserved: false, fault: "cancel" },
  { rootObserved: false, fault: "poll" },
])(
  "joins a failed authority close without an unhandled rejection ($fault, root observed=$rootObserved)",
  async ({ rootObserved, fault }) => {
    mockProcessPlatform("darwin");
    let failWrite = false;
    const stub = createWritableRelayChild((_chunk, _encoding, callback) => {
      callback(failWrite ? new Error("synthetic control delivery failed") : undefined);
    });
    const { control, lineage } = stub;
    mocks.spawn.mockReturnValue(stub.child);
    let cleanup: Promise<ProcessExtinctionResult> | undefined;
    const starting = createServiceChildRelayAdapter({
      ...relayDefaults,
      command: "synthetic-child",
      stdinMode: "pipe-open",
      onSpawnCleanup: (promise) => {
        cleanup = promise;
      },
    });
    const { emit } = relayPeer(stub);
    emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
    const { adapter, ready } = await starting;
    await ready;
    if (rootObserved) {
      emit({ type: "root-result", code: 0, signal: null });
    }
    const failure = new Error("synthetic cleanup observer failed");
    adapter.onError(() => {
      throw failure;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      if (fault === "poll") {
        vi.spyOn(process, "kill").mockReturnValue(true);
        mocks.delay.mockRejectedValueOnce(failure);
        emit({ type: "closing", reason: "cancel" });
        lineage.end();
        stub.emitExit(0);
      }
      if (fault === "cancel") {
        failWrite = true;
        adapter.kill("SIGTERM");
      } else {
        control.destroy();
      }
      await nextTurn();
      await nextTurn();
      expect(unhandled).not.toHaveBeenCalled();
      await expect(Promise.allSettled([cleanup, adapter.waitForExtinction()])).resolves.toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
      if (rootObserved) {
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      } else {
        await expect(adapter.wait()).rejects.toBe(failure);
      }
    } finally {
      process.off("unhandledRejection", unhandled);
      adapter.dispose();
      control.destroy();
      lineage.destroy();
      stub.emitExit(0);
    }
  },
);
