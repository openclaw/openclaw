import { Duplex, PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import { encodeServiceChildMessage } from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import type { ProcessExtinctionResult } from "./types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), delay: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: mocks.delay,
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
    const stub = createStubChild();
    let failWrite = false;
    const control = new Duplex({
      autoDestroy: false,
      read() {},
      write(_chunk, _encoding, callback) {
        callback(failWrite ? new Error("synthetic control delivery failed") : undefined);
      },
    });
    const lineage = new PassThrough();
    Object.defineProperty(stub.child, "stdio", {
      value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control, lineage],
    });
    mocks.spawn.mockReturnValue(stub.child);
    let cleanup: Promise<ProcessExtinctionResult> | undefined;
    const starting = createServiceChildRelayAdapter({
      command: "synthetic-child",
      args: [],
      stdinMode: "pipe-open",
      oomScoreWrapperSelected: false,
      onSpawnCleanup: (promise) => {
        cleanup = promise;
      },
    });
    const start = firstMockArg(stub.sendMock, "relay start");
    if (!isRecord(start) || typeof start.generation !== "string") {
      throw new Error("Expected relay generation");
    }
    control.push(
      Buffer.from(
        encodeServiceChildMessage({
          type: "ready",
          generation: start.generation,
          sequence: 1,
          commandPid: 1234,
          anchorPid: 1235,
        }),
      ),
    );
    const { adapter, ready } = await starting;
    await ready;
    if (rootObserved) {
      control.push(
        Buffer.from(
          encodeServiceChildMessage({
            type: "root-result",
            generation: start.generation,
            sequence: 2,
            code: 0,
            signal: null,
          }),
        ),
      );
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
        control.push(
          Buffer.from(
            encodeServiceChildMessage({
              type: "closing",
              generation: start.generation,
              sequence: 2,
              reason: "cancel",
            }),
          ),
        );
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
      // The Gateway-side join retains failure as a value and cannot reject the process.
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
