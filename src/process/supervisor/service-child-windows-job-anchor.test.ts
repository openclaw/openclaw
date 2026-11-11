import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlMessage,
  ServiceChildStart,
} from "./service-child-protocol.js";

const native = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), spawn: vi.fn() }));
vi.mock("@openclaw/proc-safe/windows-job", () => ({
  WindowsJob: { create: native.create },
}));

it("permits explicit handoff escape while retaining cleanup of a prepared command Job", async () => {
  const exitCode = process.exitCode;
  const descriptors = ["connected", "send", "disconnect", "exitCode"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(process, name)] as const,
  );
  const listeners = new Map<string | symbol, (...args: unknown[]) => void>();
  const prepared = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const sent: ServiceChildAnchorMessage[] = [];
  native.create.mockReturnValue({ close: native.close, spawn: native.spawn });
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(event, listener);
    return process;
  });
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    listeners.set(event, listener);
    return process;
  });
  Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    send: {
      configurable: true,
      value: (message: ServiceChildAnchorMessage, callback: (error: null) => void) => {
        sent.push(message);
        callback(null);
        if (message.type === "prepared") {
          prepared.resolve();
        }
      },
    },
    disconnect: { configurable: true, value: () => closed.resolve() },
  });
  let receive: ((message: ServiceChildStart | ServiceChildControlMessage) => void) | undefined;
  try {
    await import("./service-child-windows-job-anchor.js");
    receive = listeners.get("message");
    assert(receive, "Windows Job anchor did not register its control receiver");
    receive({
      type: "prepare",
      generation: "prepared-gateway",
      command: "gateway.exe",
      args: [],
      stdinMode: "pipe-closed",
      windowsShellCommand: "gateway.exe",
    });
    await prepared.promise;
    expect(native.create).toHaveBeenCalledExactlyOnceWith({ allowBreakaway: true });
  } finally {
    receive?.({ type: "cancel", generation: "prepared-gateway", sequence: 1, signal: "SIGTERM" });
    if (receive) {
      await closed.promise;
    }
    vi.restoreAllMocks();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(process, name, descriptor);
      } else {
        Reflect.deleteProperty(process, name);
      }
    }
    process.exitCode = exitCode;
  }
  expect(native.spawn).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalledOnce();
  expect(sent.map(({ type }) => type)).toEqual(["prepared", "closing"]);
});
