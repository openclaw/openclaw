import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { expect, it, onTestFinished, vi } from "vitest";
import { createSpawnBrokerHost } from "./host.js";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/spawn-broker.js"),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
vi.mock("./cleanup.js", () => ({
  terminateBrokerProcessGroup: () => ({ force: vi.fn(), settled: Promise.resolve() }),
}));

it.each([true, false])(
  "releases idle IPC while retaining open native claims (channel controls: %s)",
  async (channelControl) => {
    const child = new ChildProcess();
    const referenced = { child: true, channel: true };
    const referenceChild = (value: boolean) => () => {
      referenced.child = value;
      if (!channelControl) {
        referenced.channel = value;
      }
    };
    const referenceChannel = (value: boolean) => () => {
      referenced.channel = value;
    };
    let exited = false;
    const exit = () => {
      exited = true;
      child.emit("disconnect");
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return true;
    };
    Object.defineProperties(child, {
      pid: { value: 41001 },
      exitCode: { get: () => (exited ? 0 : null) },
      connected: { get: () => !exited },
      ref: { value: referenceChild(true) },
      unref: { value: referenceChild(false) },
      channel: {
        value: channelControl
          ? { ref: referenceChannel(true), unref: referenceChannel(false) }
          : {},
      },
      send: {
        value: (
          message: unknown,
          ...args: Array<SendHandle | MessageOptions | ((error: Error | null) => void) | undefined>
        ) => {
          args.find((arg) => typeof arg === "function")?.(null);
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "shutdown"
          ) {
            queueMicrotask(exit);
          }
          return true;
        },
      },
      kill: { value: exit },
    });
    native.spawn.mockReturnValueOnce(child);
    const host = createSpawnBrokerHost({ nativeResources: true });
    onTestFinished(async () => {
      try {
        await host.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    child.emit("message", { type: "ready", pid: child.pid });
    await host.ready();
    const lease = host.captureNativeResource(
      { moduleUrl: "file:///synthetic/resource.mjs", ownerPort: true },
      { message: vi.fn(), failed: vi.fn() },
    );
    try {
      expect(referenced).toEqual({ child: true, channel: true });
      lease.receive({
        type: "resource-ready",
        id: lease.attachment.id,
        pid: child.pid!,
        generation: 0,
      });
      lease.receive({ type: "resource-created", id: lease.attachment.id });
    } finally {
      lease.receive({ type: "resource-closed", id: lease.attachment.id, requestId: 0 });
      lease.release();
    }
    expect(referenced).toEqual({ child: false, channel: false });
  },
);
