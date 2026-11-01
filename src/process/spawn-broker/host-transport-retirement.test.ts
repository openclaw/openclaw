import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createStubChild } from "../supervisor/adapters/child.test-support.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import type { BrokerNativeResourceCallbacks, BrokerNativeResourceLease } from "./resource-host.js";
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
function brokerFixture(channelControl = false) {
  const stub = createStubChild(41001);
  const worker = stub.child;
  const output = new PassThrough();
  const deliveries = new Map<string, ReturnType<typeof createDeferredCore<unknown>>>();
  const sent = (type: string) => {
    const delivery = deliveries.get(type) ?? createDeferredCore<unknown>();
    deliveries.set(type, delivery);
    return delivery;
  };
  let sendFailure: SendFailure | undefined;
  let exited = false;
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
  Object.defineProperties(worker, {
    stdio: { value: [null, null, output] },
    stderr: { value: output },
    channel: {
      value: channelControl ? { ref: referenceChannel(true), unref: referenceChannel(false) } : {},
    },
  });
  Object.assign(worker, { ref: referenceChild(true), unref: referenceChild(false) });
  stub.sendMock.mockImplementation((message: unknown, ...args: unknown[]) => {
    if (!message || typeof message !== "object" || !("type" in message)) {
      throw new Error("Expected an unframed fixture request");
    }
    sent(String(message.type)).resolve(message);
    const callback = args.find(
      (arg): arg is (error: Error | null) => void => typeof arg === "function",
    );
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
  });
  native.spawn.mockReturnValueOnce(worker);
  const host = createSpawnBrokerHost({ nativeResources: true });
  const leases: BrokerNativeResourceLease[] = [];
  const fixture = {
    host,
    worker,
    referenced,
    disconnect: stub.disconnectMock,
    kill: stub.killMock,
    leases,
    async ready() {
      worker.emit("message", { type: "ready", pid: worker.pid });
      await host.ready();
    },
    capture(callbacks: BrokerNativeResourceCallbacks = { message: vi.fn(), failed: vi.fn() }) {
      const lease = host.captureNativeResource(
        { moduleUrl: "file:///synthetic/resource.mjs", ownerPort: true },
        callbacks,
      );
      leases.push(lease);
      return lease;
    },
    sent: (type: string) => sent(type).promise,
    failSend: (failure: SendFailure) => {
      sendFailure = failure;
    },
    stderr: (text: string) => output.write(text),
    exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      if (!exited) {
        exited = true;
        stub.emitExit(code, signal);
      }
    },
    close: () => output.destroy(),
  };
  fixtures.push(fixture);
  return fixture;
}

it.each([true, false])(
  "releases idle IPC while retaining open native claims (channel controls: %s)",
  async (channelControl) => {
    const fixture = brokerFixture(channelControl);
    const { worker, referenced } = fixture;
    await fixture.ready();
    const lease = fixture.capture();
    expect(referenced).toEqual({ child: true, channel: true });
    lease.receive({
      type: "resource-ready",
      id: lease.attachment.id,
      pid: worker.pid!,
      generation: 0,
    });
    lease.receive({ type: "resource-created", id: lease.attachment.id });
    lease.receive({ type: "resource-closed", id: lease.attachment.id, requestId: 0 });
    lease.release();
    expect(referenced).toEqual({ child: false, channel: false });
  },
);

it.each(["before", "after disconnect"] as const)(
  "classifies a nonzero broker exit %s close while waiting for late stderr",
  async (exitTiming) => {
    const fixture = brokerFixture();
    await fixture.ready();
    if (exitTiming === "before") {
      fixture.exit(null, "SIGKILL");
    } else if (exitTiming === "after disconnect") {
      fixture.disconnect();
    }
    const closing = fixture.host.close();
    const settled = vi.fn();
    void closing.then(settled, settled);
    if (exitTiming === "after disconnect") {
      fixture.exit(null, "SIGKILL");
    }
    await fixture.host.waitForCleanup();
    expect(settled).not.toHaveBeenCalled();
    fixture.stderr("late broker diagnostic\n");
    fixture.close();
    await expect(closing).resolves.toBeUndefined();
    fixtures.splice(fixtures.indexOf(fixture), 1);
  },
);

it("releases undispatched native claims only after refused startup and broker close", async () => {
  const fixture = brokerFixture();
  const closed = createDeferredCore();
  const lease = fixture.capture({
    message: (message) => {
      if (message.type === "resource-closed") {
        closed.resolve();
      }
    },
    failed() {},
  });
  fixture.worker.emit("message", {
    type: "startup-failed",
    error: { message: "listen EPERM: synthetic socket", code: "EPERM", syscall: "listen" },
  });
  await expect(fixture.host.ready()).rejects.toThrow("listen EPERM: synthetic socket");
  expect(() => lease.release()).toThrow("Native resource must close before release");
  fixture.exit();
  expect(() => lease.release()).toThrow("Native resource must close before release");
  fixture.close();
  await closed.promise;
  await expect(lease.close()).resolves.toBeUndefined();
  lease.release();
  await fixture.host.close();
});

it("retires a connected native broker after its startup deadline without killing its isolate", async () => {
  const fixture = brokerFixture();
  native.now.mockReturnValue(SPAWN_BROKER_STARTUP_TIMEOUT_MS);
  fixture.host.serviceNativeResources();
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
});

it.each([
  "frame",
  "readiness",
  "native readiness",
  "native callback",
  "startup receipt",
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
    await fixture.ready();
    const failed = createDeferredCore<Error>();
    const callbacks = { message: vi.fn(), failed: vi.fn((error: Error) => failed.resolve(error)) };
    const lease = fixture.capture(callbacks);
    const id = lease.attachment.id;
    lease.receive({ type: "resource-ready", id, pid: worker.pid!, generation: 0 });
    lease.receive({ type: "resource-created", id });
    lease.ownerMessage({ operation: "accepted native write" });
    await fixture.sent("resource-owner");

    let launchSettlement: Promise<unknown> | undefined;
    const launchSettled = vi.fn();
    const child = host.spawn("synthetic-command", [], { stdio: "ignore" }, (launch, settlement) => {
      launchSettlement = settlement;
      void settlement?.then(launchSettled);
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
    } else if (failure === "startup receipt") {
      worker.emit("message", {
        type: "startup-failed",
        error: { message: "unexpected startup failure after readiness" },
      });
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
    await failed.promise;
    await child.waitForClose();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(native.groupCleanup).not.toHaveBeenCalled();
    expect(native.childCleanup).not.toHaveBeenCalled();
    expect(launchSettled).not.toHaveBeenCalled();
    expect(() => lease.release()).toThrow("Native resource must close before release");
    await expect(host.close()).rejects.toThrow(
      "Native resource claims must close before broker shutdown",
    );

    // Only an independently observed native close, not proxy failure, releases the claim.
    lease.receive({ type: "resource-closed", id, requestId: 0 });
    lease.release();
    const hostClosed = vi.fn();
    const closing = host.close().then(hostClosed);
    fixture.exit();
    await host.waitForCleanup();
    expect(native.groupCleanup).toHaveBeenCalledTimes(process.platform === "win32" ? 0 : 1);
    expect(launchSettled).not.toHaveBeenCalled();
    expect(hostClosed).not.toHaveBeenCalled();
    fixture.close();
    await closing;
    await launchSettlement;
    expect(launchSettled).toHaveBeenCalled();
  },
);
