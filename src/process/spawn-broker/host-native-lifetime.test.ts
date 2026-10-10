import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

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

let host: SpawnBrokerHost | undefined;
const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
afterEach(async () => {
  try {
    await host?.close();
  } finally {
    host = undefined;
    if (bunDescriptor) {
      Object.defineProperty(process.versions, "bun", bunDescriptor);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    vi.restoreAllMocks();
  }
});

it.each([
  { bun: undefined, channelControl: true },
  { bun: "1.4.3", channelControl: true },
  { bun: "1.4.2", channelControl: false },
])(
  "releases the idle IPC channel while retaining open native claims (Bun=$bun)",
  async ({ bun, channelControl }) => {
    Object.defineProperty(process.versions, "bun", { value: bun, configurable: true });
    const child = new ChildProcess();
    const referenced = { child: true, channel: true };
    let exited = false;
    const exit = () => {
      exited = true;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    };
    Object.defineProperties(child, {
      pid: { value: 41001 },
      exitCode: { get: () => (exited ? 0 : null) },
      connected: { get: () => !exited },
      ref: {
        value: () => {
          referenced.child = true;
          if (!channelControl) {
            referenced.channel = true;
          }
        },
      },
      unref: {
        value: () => {
          referenced.child = false;
          if (!channelControl) {
            referenced.channel = false;
          }
        },
      },
      channel: {
        value: channelControl
          ? {
              ref: () => {
                referenced.channel = true;
              },
              unref: () => {
                referenced.channel = false;
              },
            }
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
      kill: {
        value: () => {
          exit();
          return true;
        },
      },
    });
    native.spawn.mockReturnValueOnce(child);
    host = createSpawnBrokerHost({ nativeResources: true });
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
