import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
import * as observeBridge from "../desktop/observe-bridge.js";
import { createDesktopSessionRegistry } from "../desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createWorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import * as support from "./service.test-support.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
let record: Awaited<ReturnType<typeof support.seedReadyNodeDesktop>>;

type LeasedEnvironmentRecord = Extract<WorkerEnvironmentRecord, { leaseId: string }>;
const changedRecord =
  (patch: Partial<LeasedEnvironmentRecord>) => (current: LeasedEnvironmentRecord) => ({
    ...current,
    ...patch,
  });

function desktopRequester(controller = new AbortController()) {
  return {
    connId: "desktop-panel-client",
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  };
}

function deferred<T>() {
  const result = createDeferred<T>();
  void result.promise.catch(() => undefined);
  return result;
}

function fakeBroker() {
  type AttachedStream = Awaited<ReturnType<NodeDesktopStreamBroker["mint"]>["attached"]>;
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
    attachNext(
      metadata: Omit<AttachedStream, "stream"> = {
        auth: "vnc-password",
        vncPassword: "worker-password",
      },
    ) {
      const attached = attachments.shift();
      if (!attached) {
        throw new Error("expected pending desktop attach");
      }
      const stream = new PassThrough();
      streams.push(stream);
      attached.resolve({ ...metadata, stream });
      return stream;
    },
    streams,
  };
}

function desktopHarness(mutableRecord = false) {
  const proof = {
    ...createNodeWorkerBundleTestNode(),
    nodeId: record.nodeDeviceId!,
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    workerHost: { enabled: true as const, capacity: { total: 1, available: 0 } },
  };
  const authority: { record: WorkerEnvironmentRecord | undefined; proofCurrent: boolean } = {
    record,
    proofCurrent: true,
  };
  const isProofCurrent = () => authority.proofCurrent;
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(
    async (request) =>
      new Promise((resolve) => {
        const finish = () =>
          resolve({ ok: false, error: { code: "ABORTED", message: "invoke aborted" } });
        if (request.signal?.aborted) {
          finish();
        } else {
          request.signal?.addEventListener("abort", finish, { once: true });
        }
      }),
  );
  const nodeTransport: NodeWorkerSupervisorTransport = {
    getCurrentNode: async (nodeId) => (nodeId === proof.nodeId ? proof : undefined),
    listCurrentNodes: async () => [proof],
    hasCurrentRunner: (nodeId) => nodeId === proof.nodeId && isProofCurrent(),
    isCurrent: isProofCurrent,
    invoke,
  };
  const streamed = fakeBroker();
  const registry = createDesktopSessionRegistry();
  const carrier = createWorkerNodeDesktopCarrier({
    store: mutableRecord ? { get: () => authority.record } : support.testState.store,
    desktopRegistry: registry,
  });
  carrier.bindRuntime({ transport: nodeTransport, streamBroker: streamed.broker });
  cleanups.push(async () => {
    await carrier.stopAll();
    await registry.stopAll();
  });
  const waitInvoked = (count = 1) =>
    support.waitForFast(() => expect(invoke).toHaveBeenCalledTimes(count));
  return {
    authority,
    carrier,
    registry,
    proof,
    invoke,
    transport: nodeTransport,
    streamed,
    waitInvoked,
  };
}

support.setupWorkerEnvironmentServiceSuite();
beforeEach(async () => {
  record = await support.seedReadyNodeDesktop("worker-desktop");
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

it("reloads desktop policy without replacing workers or closing other desktop sources", async () => {
  const { carrier, registry, proof, invoke, transport, streamed, waitInvoked } = desktopHarness();
  support.testState.config.cloudWorkers!.desktop = false;
  const workerService = support.createService(support.createProvider(), {
    nodeDesktopCarrier: carrier,
  });
  await registry.activate({ sourceKey: "host", ownerEpoch: 1 });
  const hostClosed = vi.fn();
  const hostObserver = registry.attachObserver("host", {
    ownerEpoch: 1,
    control: false,
    close: hostClosed,
  });
  const pendingNode = createDeferred<NodeWorkerSupervisorNodeProof>();
  try {
    expect(workerService.get(record.environmentId)?.desktopAvailable).toBe(false);
    await expect(
      workerService.observeDesktop({ environmentId: record.environmentId, control: false }),
    ).rejects.toThrow("worker desktop observe is disabled");

    support.testState.config.cloudWorkers!.desktop = true;
    await workerService.reconcileDesktopPolicy();
    expect(workerService.get(record.environmentId)?.desktopAvailable).toBe(true);
    const observing = workerService.observeDesktop({
      environmentId: record.environmentId,
      control: false,
    });
    await waitInvoked();
    const stream = streamed.attachNext();
    await observing;
    const workerClosed = vi.fn();
    registry.attachObserver(record.environmentId, {
      ownerEpoch: record.ownerEpoch,
      control: false,
      close: workerClosed,
    });
    const getCurrentNode = vi
      .spyOn(transport, "getCurrentNode")
      .mockReturnValue(pendingNode.promise);
    const pendingObservation = workerService
      .observeDesktop({ environmentId: record.environmentId, control: false })
      .catch((error: unknown) => error);
    const pendingLaunch = workerService
      .launchDesktopApp({ environmentId: record.environmentId, app: "browser" })
      .catch((error: unknown) => error);
    await support.waitForFast(() => expect(getCurrentNode).toHaveBeenCalledTimes(2));

    support.testState.config.cloudWorkers!.desktop = false;
    await workerService.reconcileDesktopPolicy();
    expect(await pendingObservation).toBeInstanceOf(Error);
    expect(await pendingLaunch).toMatchObject({ code: "invalid_state" });
    expect(stream.destroyed).toBe(true);
    expect(workerClosed).toHaveBeenCalledOnce();
    expect(hostClosed).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(workerService.get(record.environmentId)).toMatchObject({
      state: record.state,
      ownerEpoch: record.ownerEpoch,
      leaseId: record.leaseId,
      desktopAvailable: false,
      desktopApps: [],
    });

    pendingNode.resolve(proof);
    support.testState.config.cloudWorkers!.desktop = true;
    await workerService.reconcileDesktopPolicy();
    const reopened = workerService.observeDesktop({
      environmentId: record.environmentId,
      control: false,
    });
    await waitInvoked(2);
    streamed.attachNext();
    await expect(reopened).resolves.toMatchObject({ transport: "rfb" });
  } finally {
    pendingNode.resolve(proof);
    hostObserver?.release();
    await workerService.stop();
  }
});

it.each(["connection close", "token release"] as const)(
  "releases abandoned observer slots on %s without disturbing another viewer",
  async (release) => {
    const { carrier, registry, streamed, waitInvoked } = desktopHarness(true);
    const controller = new AbortController();
    const requester = desktopRequester(controller);
    const closeKeeper = vi.fn();
    const explicitRelease = release === "token release";
    const count = explicitRelease ? 20 : 8;
    if (explicitRelease) {
      await registry.activate({ sourceKey: record.environmentId, ownerEpoch: record.ownerEpoch });
    }
    const keeper = explicitRelease
      ? registry.attachObserver(record.environmentId, {
          ownerEpoch: record.ownerEpoch,
          control: true,
          close: closeKeeper,
        })
      : undefined;
    if (explicitRelease) {
      expect(keeper).toBeDefined();
    }
    try {
      for (let index = 0; index < count; index += 1) {
        const connection = explicitRelease ? controller : new AbortController();
        const pending = carrier.observe({
          record,
          control: explicitRelease,
          requester: explicitRelease
            ? requester
            : { signal: connection.signal, isCurrent: () => !connection.signal.aborted },
        });
        await waitInvoked(index + 1);
        const stream = streamed.attachNext();
        const observed = await pending;
        if (explicitRelease) {
          expect(await observeBridge.releaseDesktopObserverToken(observed.wsPath, requester)).toBe(
            true,
          );
          expect(stream.destroyed).toBe(true);
          expect(await observeBridge.releaseDesktopObserverToken(observed.wsPath, requester)).toBe(
            false,
          );
          expect(closeKeeper).not.toHaveBeenCalled();
        } else {
          connection.abort();
        }
      }
      if (explicitRelease) {
        expect(controller.signal.aborted).toBe(false);
        expect(streamed.streams.every((stream) => stream.destroyed)).toBe(true);
      } else {
        await support.waitForFast(() =>
          expect(streamed.streams.filter((stream) => !stream.destroyed)).toHaveLength(0),
        );
        const reopened = carrier.observe({ record, control: false });
        await waitInvoked(9);
        streamed.attachNext();
        await expect(reopened).resolves.toMatchObject({ transport: "rfb" });
      }
    } finally {
      controller.abort();
      keeper?.release();
    }
  },
);

it.each(["observation release", "epoch replacement"] as const)(
  "joins retiring invocation settlement when stop overlaps %s",
  async (retirement) => {
    const { authority, carrier, registry, invoke, streamed, waitInvoked } = desktopHarness(true);
    const invocation = deferred<Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>>();
    const completionOrder: string[] = [];
    invoke.mockImplementation(async () => {
      const result = await invocation.promise;
      completionOrder.push("invocation");
      return result;
    });
    const replacing = retirement === "epoch replacement";
    const closeHost = vi.fn();
    await registry.activate({ sourceKey: "host", ownerEpoch: 1 });
    const hostViewer = replacing
      ? registry.attachObserver("host", { ownerEpoch: 1, control: true, close: closeHost })
      : undefined;
    if (replacing) {
      expect(hostViewer).toBeDefined();
    }
    const controller = new AbortController();
    const requester = desktopRequester(controller);
    const canceledResult = { ok: false, error: { code: "ABORTED", message: "invoke aborted" } };
    try {
      const observing = carrier.observe({ record, control: false, requester });
      await waitInvoked();
      const stream = streamed.attachNext();
      const observed = await observing;
      const current = replacing ? { ...record, ownerEpoch: record.ownerEpoch + 1 } : record;
      authority.record = current;
      const retiring = replacing
        ? carrier.observe({ record: current, control: false, requester }).then(
            () => true,
            () => false,
          )
        : observeBridge.releaseDesktopObserverToken(observed.wsPath, requester).then((released) => {
            completionOrder.push("release");
            return released;
          });
      expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(stream.destroyed).toBe(true);
      const stopping = (
        replacing ? carrier.stopAll() : carrier.stop(record.environmentId, record.ownerEpoch)
      ).then(() => {
        completionOrder.push("stop");
      });
      await setImmediate();
      invocation.resolve(canceledResult);
      expect(await retiring).toBe(!replacing);
      await stopping;
      expect(completionOrder[0]).toBe("invocation");
      if (replacing) {
        expect(invoke).toHaveBeenCalledOnce();
        expect(completionOrder).toEqual(["invocation", "stop"]);
        expect(closeHost).not.toHaveBeenCalled();
      }
    } finally {
      invocation.resolve(canceledResult);
      controller.abort();
    }
  },
);

it.each([undefined, "worker"])(
  "observes an exact durable node desktop with lease username %s",
  async (username) => {
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const client = { invalidated: false };
    const requester = {
      signal: new AbortController().signal,
      isCurrent: () => !client.invalidated,
    };
    if (username) {
      record.desktop = { ...record.desktop!, username };
    }
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { authority, carrier, invoke, streamed, waitInvoked } = desktopHarness(true);

    const observing = carrier.observe({ record, control: false, requester });
    await waitInvoked();
    nowMs = 50_000;
    const credentials = username
      ? { username, password: "worker-password" }
      : { password: "worker-password" };
    streamed.attachNext({
      auth: username ? "ard-account" : "vnc-password",
      vncPassword: "worker-password",
    });

    const observed = await observing;
    expect(observed).toMatchObject({
      transport: "rfb",
      wsPath: expect.stringMatching(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u),
      expiresAtMs: 110_000,
      control: false,
    });
    expect(observed).not.toHaveProperty("vncPassword");
    expect(observed).not.toHaveProperty("preauth");
    expect(mint.mock.calls[0]?.[0].preauth).toEqual({
      auth: username ? "ard-account" : "vnc-password",
      credentials,
    });
    const mintedRequester = mint.mock.calls[0]?.[0].requester;
    expect(mintedRequester).toBe(requester);
    expect(mintedRequester?.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(mintedRequester?.isCurrent()).toBe(false);
    expect(requester.signal.aborted).toBe(false);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          ticket: "a".repeat(48),
          attachPath: `/node-desktop/attach?ticket=${"a".repeat(48)}`,
          port: 5900,
          passwordFilePath: "/var/lib/crabbox/vnc.password",
          ...(username ? { username } : {}),
        },
        timeoutMs: 0,
      }),
    );

    authority.record = undefined;
    authority.proofCurrent = false;
    await carrier.stop(record.environmentId, record.ownerEpoch);
    expect(streamed.streams[0]?.destroyed).toBe(true);
  },
);

it.each([
  { auth: "ard-account" as const },
  { auth: "vnc-password" as const, vncPassword: "secret" },
])("rejects cloud ARD metadata without managed account authentication: %j", async (metadata) => {
  record.desktop = { ...record.desktop!, username: "worker" };
  const { carrier, streamed, waitInvoked } = desktopHarness(true);
  const observing = carrier.observe({ record, control: false });
  await waitInvoked();
  const stream = streamed.attachNext(metadata);
  await expect(observing).rejects.toThrow("managed authentication");
  expect(stream.destroyed).toBe(true);
});

it("cancels and joins an admitted app launch before its first microtask", async () => {
  const { carrier, invoke } = desktopHarness();
  invoke.mockResolvedValue({ ok: true, payloadJSON: '{"status":"ready"}' });
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
  const [error] = await Promise.all([launched, stopping]);
  expect(error).toMatchObject({ message: "Worker environment node desktop owner stopped" });
  expect(invoke).not.toHaveBeenCalled();
  expect(completionOrder).toEqual(["launch", "stop"]);
});

it.each([
  ["pairing proof", changedRecord({})],
  ["lease", changedRecord({ leaseId: "lease:replacement" })],
  ["node", changedRecord({ nodeDeviceId: "node:replacement" })],
  [
    "epoch",
    (current: LeasedEnvironmentRecord) => ({ ...current, ownerEpoch: current.ownerEpoch + 1 }),
  ],
  ["state", changedRecord({ state: "draining" })],
  ["destroy intent", changedRecord({ destroyRequestedAtMs: 2_000 })],
  [
    "desktop descriptor",
    (current: LeasedEnvironmentRecord) => ({
      ...current,
      desktop: current.desktop ? { ...current.desktop, port: current.desktop.port + 1 } : null,
    }),
  ],
] as const)("rejects an attach after the %s changes", async (_name, mutate) => {
  if (record.leaseId === null) {
    throw new Error("Expected a leased desktop fixture");
  }
  const { authority, carrier, streamed, waitInvoked } = desktopHarness(_name !== "pairing proof");

  const observing = carrier.observe({ record, control: true });
  await waitInvoked();
  authority.record = mutate(record);
  authority.proofCurrent = _name !== "pairing proof";
  const stream = streamed.attachNext();

  await expect(observing).rejects.toThrow(
    _name === "pairing proof"
      ? "owner changed before attachment"
      : /owner changed|connection is not current/u,
  );
  expect(stream.destroyed).toBe(true);
});

it("deduplicates one exact launch and aborts it on owner teardown", async () => {
  const { carrier, invoke, waitInvoked } = desktopHarness();
  const app = structuredClone(support.DESKTOP.apps![0]!);
  const expectedApp = structuredClone(app);

  await expect(
    carrier.launchApp({
      record,
      app: { ...app, executablePath: "/usr/local/bin/not-advertised" },
    }),
  ).rejects.toThrow("app descriptor is not current");
  expect(invoke).not.toHaveBeenCalled();

  const first = carrier.launchApp({ record, app });
  const second = carrier.launchApp({ record, app });
  expect(second).toBe(first);
  app.executablePath = "/changed-request-app";
  record.desktop!.apps![0]!.executablePath = "/changed-record-app";
  await waitInvoked();
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({ params: expectedApp, timeoutMs: 30_000 }),
  );

  await carrier.stop(record.environmentId, record.ownerEpoch);
  await expect(first).rejects.toThrow("invoke aborted");
  await expect(second).rejects.toThrow("invoke aborted");
  expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
});

it.each([
  ["ready", '{"status":"ready"}', undefined, undefined],
  ["missing receipt", null, undefined, /invalid result/u],
  ["open receipt", '{"status":"ready","extra":true}', undefined, /invalid result/u],
  ["stale durable owner", '{"status":"ready"}', "durable owner", "launch owner changed"],
  ["stale pairing proof", '{"status":"ready"}', "pairing proof", "launch owner changed"],
] as const)("validates the node launcher %s result", async (name, payloadJSON, stale, error) => {
  const { authority, carrier, invoke, waitInvoked } = desktopHarness(Boolean(stale));
  const invocation = deferred<{ ok: boolean; payloadJSON: string | null }>();
  invoke.mockImplementation(async () =>
    stale ? await invocation.promise : { ok: true, payloadJSON },
  );
  const launched = carrier.launchApp({ record, app: support.DESKTOP.apps![0]! });
  if (stale) {
    await waitInvoked();
    if (stale === "durable owner") {
      authority.record = { ...record, ownerEpoch: record.ownerEpoch + 1 };
    } else {
      authority.proofCurrent = false;
    }
    invocation.resolve({ ok: true, payloadJSON });
  }
  if (error) {
    await expect(launched).rejects.toThrow(error);
  } else {
    await expect(launched).resolves.toBeUndefined();
  }
  expect(invoke).toHaveBeenCalledOnce();
});
