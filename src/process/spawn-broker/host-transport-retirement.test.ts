import { ChildProcess, type MessageOptions, type SendHandle } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import type { BrokerNativeResourceLease } from "./resource-host.js";
import { SPAWN_BROKER_STARTUP_TIMEOUT_MS } from "./resource-protocol.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  now: vi.fn(() => 0),
  groupCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
  childCleanup: vi.fn(() => ({ force: vi.fn(), settled: Promise.resolve() })),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
// mock-isolation: This fixture owns synthetic process events, not compiled worker preparation.
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/spawn-broker.js"),
  resolveRuntimeWorkerArgv: () => ["synthetic-spawn-broker"],
}));
// mock-isolation: Synthetic process identities must never authorize real process signals.
vi.mock("./cleanup.js", () => ({
  terminateBrokerProcessGroup: native.groupCleanup,
  terminateLostBrokerChild: native.childCleanup,
}));
vi.mock("./resource-protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resource-protocol.js")>()),
  spawnBrokerStartupNowMs: native.now,
}));

const fixtures: Array<{
  host: SpawnBrokerHost;
  exit(): void;
  close(): void;
  leases: BrokerNativeResourceLease[];
}> = [];

beforeEach(() => {
  vi.clearAllMocks();
  native.now.mockReturnValue(0);
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const lease of fixture.leases) {
      lease.receive({ type: "resource-closed", id: lease.attachment.id, requestId: 0 });
      lease.release();
    }
    // Unwind even on a failed assertion; no real broker or native operation was started.
    fixture.exit();
    fixture.close();
    await fixture.host.close();
  }
});

type SendFailure = { type: string; mode: "callback" | "throw" };
function brokerFixture(bootstrapFailure?: SendFailure) {
  const worker = new ChildProcess();
  const output = new PassThrough();
  const deliveries = new Map<string, ReturnType<typeof createDeferredCore<unknown>>>();
  const sent = (type: string) => {
    let delivery = deliveries.get(type);
    if (!delivery) {
      delivery = createDeferredCore<unknown>();
      deliveries.set(type, delivery);
    }
    return delivery;
  };
  let sendFailure = bootstrapFailure;
  let connected = true;
  let exited = false;
  let closed = false;
  const disconnect = vi.fn(() => {
    connected = false;
    worker.emit("disconnect");
  });
  // Like the real worker, SIGTERM does not retire a connected broker.
  const kill = vi.fn(() => true);
  Object.defineProperties(worker, {
    pid: { value: 41001 },
    stdio: { value: [null, output, null] },
    connected: { get: () => connected },
    exitCode: { get: () => (exited ? 0 : null) },
    disconnect: { value: disconnect },
    kill: { value: kill },
    send: {
      value: (
        message: unknown,
        ...args: Array<SendHandle | MessageOptions | ((error: Error | null) => void) | undefined>
      ) => {
        if (!message || typeof message !== "object" || !("type" in message)) {
          throw new Error("Expected an unframed fixture request");
        }
        sent(String(message.type)).resolve(message);
        const callback = args.find((arg) => typeof arg === "function");
        if (sendFailure && sendFailure.type === message.type) {
          const error = new Error("synthetic IPC write failed");
          if (sendFailure.mode === "throw") {
            throw error;
          }
          callback?.(error);
          return false;
        }
        callback?.(null);
        return true;
      },
    },
  });
  native.spawn.mockReturnValueOnce(worker);
  const host = createSpawnBrokerHost({ nativeResources: true });
  const leases: BrokerNativeResourceLease[] = [];
  const fixture = {
    host,
    worker,
    disconnect,
    kill,
    leases,
    sent: (type: string) => sent(type).promise,
    failSend: (failure: SendFailure) => {
      sendFailure = failure;
    },
    exit: () => {
      if (!exited) {
        exited = true;
        worker.emit("exit", 0, null);
      }
    },
    close: () => {
      if (!closed) {
        closed = true;
        output.destroy();
      }
    },
  };
  fixtures.push(fixture);
  return fixture;
}

it.each(["callback", "throw", "deadline"] as const)(
  "retires a connected native broker after bootstrap %s failure without killing its isolate",
  async (mode) => {
    const fixture = brokerFixture(mode === "deadline" ? undefined : { type: "bootstrap", mode });
    if (mode === "deadline") {
      native.now.mockReturnValue(SPAWN_BROKER_STARTUP_TIMEOUT_MS);
      fixture.host.serviceNativeResources();
    }
    await expect(fixture.host.ready()).rejects.toMatchObject({
      code: "ERR_SPAWN_BROKER_UNAVAILABLE",
    });
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(native.groupCleanup).not.toHaveBeenCalled();
    const closing = fixture.host.close();
    fixture.exit();
    fixture.close();
    await closing;
  },
);

it.each([
  "frame",
  "readiness",
  "native readiness",
  "native callback",
  "child error",
  "pipe setup",
  "pipe receipt callback",
  "pipe receipt throw",
  "orphan pipe receipt",
  "orphan launch refusal",
] as const)(
  "hands off %s failure before joining, retaining native claims and granted launch settlement",
  async (failure) => {
    const fixture = brokerFixture();
    const { host, worker } = fixture;
    worker.emit("message", { type: "ready", pid: worker.pid });
    await host.ready();
    const failed = createDeferredCore<Error>();
    const callbacks = { message: vi.fn(), failed: vi.fn((error: Error) => failed.resolve(error)) };
    const lease = host.captureNativeResource(
      { moduleUrl: "file:///synthetic/resource.mjs", ownerPort: true },
      callbacks,
    );
    fixture.leases.push(lease);
    const id = lease.attachment.id;
    lease.receive({ type: "resource-ready", id, pid: worker.pid!, generation: 0 });
    lease.receive({ type: "resource-created", id });
    const write = lease.ownerMessage({ operation: "accepted native write" });
    await fixture.sent("resource-owner");

    let launchSettlement: Promise<unknown> | undefined;
    let launchSettled = false;
    const child = host.spawn("synthetic-command", [], { stdio: "ignore" }, (launch, settlement) => {
      launchSettlement = settlement;
      void settlement?.then(() => {
        launchSettled = true;
      });
      return launch();
    });
    await fixture.sent("prepare-spawn");
    worker.emit("message", { type: "prepared", id: child.requestId });
    await fixture.sent("launch");
    expect(launchSettlement).toBeDefined();

    if (failure === "frame") {
      worker.emit("message", { kind: "openclaw-spawn-broker-frame" });
    } else if (failure === "readiness") {
      worker.emit("message", { type: "ready", pid: 41002 });
    } else if (failure === "native readiness") {
      worker.emit("message", { type: "resource-ready", id, pid: worker.pid, generation: 1 });
    } else if (failure === "native callback") {
      callbacks.message.mockImplementationOnce(() => {
        throw new Error("synthetic receiver failed");
      });
      worker.emit("message", { type: "resource-target", id, value: "synthetic response" });
    } else if (failure === "child error") {
      worker.emit("error", new Error("synthetic child IPC error"));
    } else if (failure === "pipe setup") {
      worker.emit("message", { type: "pipe", id: child.requestId, fd: 1 });
    } else if (failure === "orphan launch refusal") {
      fixture.failSend({ type: "launch", mode: "callback" });
      worker.emit("message", { type: "prepared", id: 999 });
    } else {
      fixture.failSend({
        type: "pipe-received",
        mode: failure === "pipe receipt throw" ? "throw" : "callback",
      });
      worker.emit("message", {
        type: "pipe",
        id: failure === "orphan pipe receipt" ? 999 : child.requestId,
        fd: 0,
        closed: true,
      });
    }

    // Proxy rejection and failed write delivery are not native settlement receipts.
    const error = await failed.promise;
    await expect(write.result).rejects.toBe(error);
    await child.waitForClose();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(native.groupCleanup).not.toHaveBeenCalled();
    expect(native.childCleanup).not.toHaveBeenCalled();
    expect(launchSettled).toBe(false);
    expect(() => lease.release()).toThrow("Native resource must close before release");
    await expect(host.close()).rejects.toThrow(
      "Native resource claims must close before broker shutdown",
    );

    // Only an independently observed native close, not proxy failure, releases the claim.
    lease.receive({ type: "resource-closed", id, requestId: 0 });
    lease.release();
    let hostClosed = false;
    const closing = host.close().then(() => {
      hostClosed = true;
    });
    fixture.exit();
    await host.waitForCleanup();
    expect(native.groupCleanup).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 1);
    expect(launchSettled).toBe(false);
    expect(hostClosed).toBe(false);
    fixture.close();
    await closing;
    await launchSettlement;
    expect(launchSettled).toBe(true);
  },
);
