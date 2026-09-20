import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import * as observeBridge from "../desktop/observe-bridge.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createWorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function nodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return {
    nodeId,
    connId: "conn-1",
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: "node",
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
    commands: [],
  };
}

function fakeBroker() {
  type AttachedStream = {
    auth: "vnc-password" | "ard-account";
    vncPassword: string;
    stream: PassThrough;
  };
  const attachments: Array<ReturnType<typeof deferred<AttachedStream>>> = [];
  const streams: PassThrough[] = [];
  const broker = {
    mint: vi.fn(() => {
      const attached = deferred<AttachedStream>();
      attachments.push(attached);
      return {
        ticket: "a".repeat(48),
        attachPath: `/node-desktop/attach?ticket=${"a".repeat(48)}`,
        expiresAtMs: support.testState.nowMs + 60_000,
        attached: attached.promise,
        cancel: () => attached.reject(new Error("ticket cancelled")),
      };
    }),
    handleUpgrade: vi.fn(),
  } as unknown as NodeDesktopStreamBroker;
  return {
    broker,
    attachNext(auth: "vnc-password" | "ard-account" = "vnc-password") {
      const attached = attachments.shift();
      if (!attached) {
        throw new Error("expected pending desktop attach");
      }
      const stream = new PassThrough();
      streams.push(stream);
      attached.resolve({ auth, vncPassword: "worker-password", stream });
      return stream;
    },
    streams,
  };
}

function pendingTransport(params: {
  proof: NodeWorkerSupervisorNodeProof;
  isProofCurrent: () => boolean;
}) {
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
    async (request) =>
      await new Promise((resolve) => {
        const finish = () =>
          resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
        if (request.signal?.aborted) {
          finish();
        } else {
          request.signal?.addEventListener("abort", finish, { once: true });
        }
      }),
  );
  const transport: NodeWorkerSupervisorTransport = {
    async getCurrentNode(nodeId) {
      return (await this.listCurrentNodes()).find((node) => node.nodeId === nodeId);
    },
    listCurrentNodes: async () => [params.proof],
    hasCurrentRunner: (nodeId) => nodeId === params.proof.nodeId && params.isProofCurrent(),
    isCurrent: () => params.isProofCurrent(),
    invoke,
  };
  return { invoke, transport };
}

describe("worker node desktop carrier", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  it("releases abandoned observer slots when requesting connections close", async () => {
    const record = support.seedReadyNodeDesktop("worker-desktop-cancel-churn");
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => true });
    const streamed = fakeBroker();
    const registry = createDesktopSessionRegistry();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => record },
      desktopRegistry: registry,
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    try {
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        const observing = carrier.observe({
          record,
          control: false,
          requester: {
            signal: controller.signal,
            isCurrent: () => !controller.signal.aborted,
          },
        });
        await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(index + 1));
        streamed.attachNext();
        await observing;
        controller.abort();
      }
      await support.waitForFast(() =>
        expect(streamed.streams.filter((stream) => !stream.destroyed)).toHaveLength(0),
      );
      const reopened = carrier.observe({ record, control: false });
      await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(9));
      streamed.attachNext();
      await expect(reopened).resolves.toMatchObject({ transport: "rfb" });
    } finally {
      await carrier.stopAll();
    }
  });

  it("releases abandoned observations without disconnecting the requester or taking control", async () => {
    const record = support.seedReadyNodeDesktop("worker-desktop-abandon");
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => true });
    const streamed = fakeBroker();
    const registry = createDesktopSessionRegistry();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => record },
      desktopRegistry: registry,
    });
    const controller = new AbortController();
    const requester = {
      connId: "desktop-panel-client",
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    };
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    await registry.activate({ sourceKey: record.environmentId, ownerEpoch: record.ownerEpoch });
    const closeKeeper = vi.fn();
    const keeper = registry.attachObserver(record.environmentId, {
      ownerEpoch: record.ownerEpoch,
      control: true,
      close: closeKeeper,
    });
    expect(keeper).toBeDefined();
    try {
      for (let index = 0; index < 20; index += 1) {
        const pending = carrier.observe({ record, control: true, requester });
        await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledTimes(index + 1));
        const stream = streamed.attachNext();
        const observed = await pending;
        expect(await observeBridge.releaseDesktopObserverToken(observed.wsPath, requester)).toBe(
          true,
        );
        expect(stream.destroyed).toBe(true);
        expect(await observeBridge.releaseDesktopObserverToken(observed.wsPath, requester)).toBe(
          false,
        );
        expect(closeKeeper).not.toHaveBeenCalled();
      }
      expect(controller.signal.aborted).toBe(false);
      expect(streamed.streams.every((stream) => stream.destroyed)).toBe(true);
    } finally {
      controller.abort();
      keeper?.release();
      await carrier.stopAll();
      await registry.stopAll();
    }
  });

  it("joins invocation settlement when owner stop overlaps observation release", async () => {
    const record = support.seedReadyNodeDesktop("worker-desktop-release-stop");
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => true });
    const invocation = deferred<Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>>();
    const completionOrder: string[] = [];
    transport.invoke.mockImplementation(async () => {
      const result = await invocation.promise;
      completionOrder.push("invocation");
      return result;
    });
    const streamed = fakeBroker();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => record },
      desktopRegistry: createDesktopSessionRegistry(),
    });
    const controller = new AbortController();
    const requester = {
      connId: "desktop-panel-client",
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    };
    const canceledResult = { ok: false, error: { code: "ABORTED", message: "invoke aborted" } };
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    try {
      const observing = carrier.observe({ record, control: false, requester });
      await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
      const stream = streamed.attachNext();
      const observed = await observing;
      const releasing = observeBridge
        .releaseDesktopObserverToken(observed.wsPath, requester)
        .then((released) => {
          completionOrder.push("release");
          return released;
        });
      expect(transport.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(stream.destroyed).toBe(true);
      const stopping = carrier.stop(record.environmentId, record.ownerEpoch).then(() => {
        completionOrder.push("stop");
      });
      await setImmediate();
      invocation.resolve(canceledResult);
      expect(await releasing).toBe(true);
      await stopping;
      expect(completionOrder[0]).toBe("invocation");
    } finally {
      invocation.resolve(canceledResult);
      controller.abort();
      await carrier.stopAll();
    }
  });

  it("joins a retiring epoch when stopAll interrupts its replacement", async () => {
    const record = support.seedReadyNodeDesktop("worker-desktop-replacement-stop");
    let current = record;
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const invocation =
      createDeferred<Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>>();
    const completionOrder: string[] = [];
    transport.invoke.mockImplementation(async () => {
      const result = await invocation.promise;
      completionOrder.push("invocation");
      return result;
    });
    const streamed = fakeBroker();
    const registry = createDesktopSessionRegistry();
    await registry.activate({ sourceKey: "host", ownerEpoch: 1 });
    const closeHost = vi.fn();
    const hostViewer = registry.attachObserver("host", {
      ownerEpoch: 1,
      control: true,
      close: closeHost,
    });
    expect(hostViewer).toBeDefined();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => current },
      desktopRegistry: registry,
    });
    const controller = new AbortController();
    const requester = {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    };
    const canceledResult = { ok: false, error: { code: "ABORTED", message: "invoke aborted" } };
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });
    try {
      const observing = carrier.observe({ record, control: false, requester });
      await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
      const stream = streamed.attachNext();
      await observing;
      current = { ...record, ownerEpoch: record.ownerEpoch + 1 };
      const replacement = carrier.observe({ record: current, control: false, requester }).then(
        () => true,
        () => false,
      );
      expect(transport.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(stream.destroyed).toBe(true);
      const stopping = carrier.stopAll().then(() => {
        completionOrder.push("stop");
      });
      await setImmediate();
      invocation.resolve(canceledResult);
      await stopping;
      expect(await replacement).toBe(false);
      expect(transport.invoke).toHaveBeenCalledOnce();
      expect(completionOrder).toEqual(["invocation", "stop"]);
      expect(closeHost).not.toHaveBeenCalled();
    } finally {
      invocation.resolve(canceledResult);
      controller.abort();
      await carrier.stopAll();
      await registry.stopAll();
    }
  });

  it.each(["vnc-password", "ard-account"] as const)(
    "observes an exact durable node desktop with %s preauthentication",
    async (auth) => {
      const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
      const client = { invalidated: false };
      const requester = {
        signal: new AbortController().signal,
        isCurrent: () => !client.invalidated,
      };
      const record = support.seedReadyNodeDesktop("worker-node-desktop-observe");
      if (auth === "ard-account") {
        record.desktop = { ...support.DESKTOP, username: "desktop-user" };
      }
      let nowMs = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      let current: WorkerEnvironmentRecord | undefined = record;
      let proofCurrent = true;
      const proof = nodeProof(record.nodeDeviceId!);
      const transport = pendingTransport({ proof, isProofCurrent: () => proofCurrent });
      const streamed = fakeBroker();
      const registry = createDesktopSessionRegistry({ lingerMs: 1 });
      const carrier = createWorkerNodeDesktopCarrier({
        store: { get: () => current },
        desktopRegistry: registry,
      });
      carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

      const observing = carrier.observe({ record, control: false, requester });
      await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
      nowMs = 50_000;
      streamed.attachNext(auth);

      await expect(observing).resolves.toMatchObject({
        transport: "rfb",
        wsPath: expect.stringMatching(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u),
        expiresAtMs: 110_000,
        control: false,
      });
      expect(await observing).not.toHaveProperty("vncPassword");
      expect(mint.mock.calls[0]?.[0].preauth).toEqual({
        auth,
        credentials: {
          password: "worker-password",
          ...(auth === "ard-account" ? { username: "desktop-user" } : {}),
        },
      });
      const mintedRequester = mint.mock.calls[0]?.[0].requester;
      expect(mintedRequester).toBe(requester);
      expect(mintedRequester?.isCurrent()).toBe(true);
      client.invalidated = true;
      expect(mintedRequester?.isCurrent()).toBe(false);
      expect(requester.signal.aborted).toBe(false);
      expect(transport.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            ticket: "a".repeat(48),
            attachPath: `/node-desktop/attach?ticket=${"a".repeat(48)}`,
            port: 5900,
            ...(auth === "ard-account" ? { username: "desktop-user" } : {}),
            passwordFilePath: "/var/lib/crabbox/vnc.password",
          },
          timeoutMs: 0,
        }),
      );

      current = undefined;
      proofCurrent = false;
      await carrier.stop(record.environmentId, record.ownerEpoch);
      expect(streamed.streams[0]?.destroyed).toBe(true);
    },
  );

  it("cancels and joins an admitted app launch before its first microtask", async () => {
    const record = support.seedReadyNodeDesktop("worker-desktop-queued-launch-stop");
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    transport.invoke.mockResolvedValue({ ok: true, payloadJSON: '{"status":"ready"}' });
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry(),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: fakeBroker().broker });
    const completionOrder: string[] = [];
    const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! }).then(
      () => {
        completionOrder.push("launch");
        return undefined;
      },
      (error: unknown) => {
        completionOrder.push("launch");
        return error;
      },
    );
    const stopping = carrier.stopAll().then(() => {
      completionOrder.push("stop");
    });
    try {
      const [error] = await Promise.all([launched, stopping]);
      expect(error).toMatchObject({ message: "Worker environment node desktop owner stopped" });
      expect(transport.invoke).not.toHaveBeenCalled();
      expect(completionOrder).toEqual(["launch", "stop"]);
    } finally {
      await carrier.stopAll();
    }
  });

  it.each([
    ["lease", (record: WorkerEnvironmentRecord) => ({ ...record, leaseId: "lease:replacement" })],
    [
      "node",
      (record: WorkerEnvironmentRecord) => ({ ...record, nodeDeviceId: "node:replacement" }),
    ],
    [
      "epoch",
      (record: WorkerEnvironmentRecord) => ({ ...record, ownerEpoch: record.ownerEpoch + 1 }),
    ],
    ["state", (record: WorkerEnvironmentRecord) => ({ ...record, state: "draining" as const })],
    [
      "destroy intent",
      (record: WorkerEnvironmentRecord) => ({ ...record, destroyRequestedAtMs: 2_000 }),
    ],
    [
      "desktop descriptor",
      (record: WorkerEnvironmentRecord) => ({
        ...record,
        desktop: record.desktop ? { ...record.desktop, port: record.desktop.port + 1 } : null,
      }),
    ],
  ] as const)("rejects an attach after the durable %s changes", async (_name, mutate) => {
    const record = support.seedReadyNodeDesktop(`worker-node-desktop-stale-${_name}`);
    let current: WorkerEnvironmentRecord | undefined = record;
    const proof = nodeProof(record.nodeDeviceId!);
    const transport = pendingTransport({ proof, isProofCurrent: () => true });
    const streamed = fakeBroker();
    const carrier = createWorkerNodeDesktopCarrier({
      store: { get: () => current },
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const observing = carrier.observe({ record, control: true });
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    current = mutate(record) as WorkerEnvironmentRecord;
    const stream = streamed.attachNext();

    await expect(observing).rejects.toThrow(/owner changed|connection is not current/u);
    expect(stream.destroyed).toBe(true);
  });

  it("rejects an attach after the node pairing proof changes", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-desktop-stale-pairing");
    let proofCurrent = true;
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => proofCurrent,
    });
    const streamed = fakeBroker();
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: streamed.broker });

    const observing = carrier.observe({ record, control: true });
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    proofCurrent = false;
    const stream = streamed.attachNext();

    await expect(observing).rejects.toThrow("owner changed before attachment");
    expect(stream.destroyed).toBe(true);
  });

  it("deduplicates one exact launch and aborts it on owner teardown", async () => {
    const record = support.seedReadyNodeDesktop("worker-node-desktop-launch");
    const transport = pendingTransport({
      proof: nodeProof(record.nodeDeviceId!),
      isProofCurrent: () => true,
    });
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({ transport: transport.transport, streamBroker: fakeBroker().broker });
    const app = support.DESKTOP.apps![0]!;

    await expect(
      carrier.launchApp({
        record,
        app: { ...app, executablePath: "/usr/local/bin/not-advertised" },
      }),
    ).rejects.toThrow("app descriptor is not current");
    expect(transport.invoke).not.toHaveBeenCalled();

    const first = carrier.launchApp({ record, app });
    const second = carrier.launchApp({ record, app });
    expect(second).toBe(first);
    await support.waitForFast(() => expect(transport.invoke).toHaveBeenCalledOnce());
    expect(transport.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ params: app, timeoutMs: 30_000 }),
    );

    await carrier.stop(record.environmentId, record.ownerEpoch);
    await expect(first).rejects.toThrow("invoke aborted");
    await expect(second).rejects.toThrow("invoke aborted");
    expect(transport.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });

  it.each([
    { name: "ready", payloadJSON: '{"status":"ready"}', succeeds: true },
    { name: "missing receipt", payloadJSON: null, succeeds: false },
    { name: "open receipt", payloadJSON: '{"status":"ready","extra":true}', succeeds: false },
  ])("validates the closed node launcher $name result", async (testCase) => {
    const record = support.seedReadyNodeDesktop(
      `worker-node-desktop-${testCase.name.replaceAll(" ", "-")}`,
    );
    const proof = nodeProof(record.nodeDeviceId!);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payloadJSON: testCase.payloadJSON,
    }));
    const carrier = createWorkerNodeDesktopCarrier({
      store: support.testState.store,
      desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    });
    carrier.bindRuntime({
      transport: {
        getCurrentNode: async (nodeId) => (proof.nodeId === nodeId ? proof : undefined),
        listCurrentNodes: async () => [proof],
        hasCurrentRunner: (nodeId) => nodeId === proof.nodeId,
        isCurrent: () => true,
        invoke,
      },
      streamBroker: fakeBroker().broker,
    });
    const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! });

    if (testCase.succeeds) {
      await expect(launched).resolves.toBeUndefined();
    } else {
      await expect(launched).rejects.toThrow(/invalid result/u);
    }
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(["durable owner", "pairing proof"] as const)(
    "rejects a successful launch receipt after the %s becomes stale",
    async (staleBoundary) => {
      const record = support.seedReadyNodeDesktop(`worker-node-launch-stale-${staleBoundary}`);
      let current: WorkerEnvironmentRecord | undefined = record;
      let proofCurrent = true;
      const proof = nodeProof(record.nodeDeviceId!);
      const invocation = deferred<{ ok: boolean; payloadJSON: string }>();
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
        async () => await invocation.promise,
      );
      const carrier = createWorkerNodeDesktopCarrier({
        store: { get: () => current },
        desktopRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
      });
      carrier.bindRuntime({
        transport: {
          getCurrentNode: async (nodeId) => (proof.nodeId === nodeId ? proof : undefined),
          listCurrentNodes: async () => [proof],
          hasCurrentRunner: (nodeId) => nodeId === proof.nodeId && proofCurrent,
          isCurrent: () => proofCurrent,
          invoke,
        },
        streamBroker: fakeBroker().broker,
      });

      const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! });
      await support.waitForFast(() => expect(invoke).toHaveBeenCalledOnce());
      if (staleBoundary === "durable owner") {
        current = { ...record, ownerEpoch: record.ownerEpoch + 1 };
      } else {
        proofCurrent = false;
      }
      invocation.resolve({ ok: true, payloadJSON: '{"status":"ready"}' });

      await expect(launched).rejects.toThrow("launch owner changed");
    },
  );
});
