import "../../../../src/test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClient, type GatewayClientOptions } from "../../../../src/gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  parseNodeRunnerInventoryDeclaration,
  resolveNodeWorkerExecutionIssue,
} from "../../../../src/infra/node-runner-inventory.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  createPairedNodeWorkerHost,
  createWireWorkspaceSettlementWaiter,
} from "./paired-node-worker-wire-fixture.js";

const transport = vi.hoisted(() => {
  class TestGatewayClient {
    connected = true;
    request = vi.fn(async (_method: string, _params?: unknown) => ({}));
    constructor(readonly options: GatewayClientOptions) {
      clients.push(this);
    }
    hello() {
      this.options.onHelloOk?.({
        type: "hello-ok",
        protocol: 4,
        server: { version: "fixture", connId: "fixture" },
        features: { methods: [], events: [] },
        auth: { role: "node", scopes: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
      });
    }
    start = () => this.hello();
    stop() {
      this.options.onClose?.(1000, "fixture stopped");
    }
    stopAndWait = async () => this.stop();
  }
  const clients: TestGatewayClient[] = [];
  return { GatewayClient: TestGatewayClient, clients };
});

vi.mock("../../../../src/gateway/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/gateway/client.js")>()),
  ...transport,
}));
vi.mock("../../../../src/infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: () => ({ deviceId: "paired-fixture-node" }),
}));
vi.mock("../../../../src/node-host/invoke.js", () => ({ handleInvoke: vi.fn() }));
vi.mock("../../../../src/node-host/node-worker-bundle-installer.js", () => ({
  NodeWorkerBundleInstaller: vi.fn(),
}));
vi.mock("../../../../src/node-host/node-worker-workspace.js", () => ({
  NodeWorkerWorkspaceRuntime: vi.fn(),
}));
vi.mock("../../../../src/node-host/node-worker-supervisor.js", () => ({
  createNodeWorkerSupervisor: () => ({ initialize: async () => {}, close: async () => {} }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  beforeEach(({ onTestFinished: afterTest }) => afterTest(cleanup)),
);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function workspace(reconciling?: boolean, manifestRef = "current") {
  return {
    session: {
      placement: {
        state: "active",
        workspaceResultReconciling: reconciling,
        workspaceBaseManifestRef: manifestRef,
      },
    },
  };
}

function settlementFixture() {
  const settlement = createWireWorkspaceSettlementWaiter();
  const controller = new AbortController();
  const outcomes = new Map<string, unknown>();
  const waits: Promise<unknown>[] = [];
  const client = { request: vi.fn() };
  onTestFinished(async () => {
    controller.abort();
    await Promise.all(waits);
  });
  return {
    ...settlement,
    controller,
    outcomes,
    client,
    async changed(this: void, payload: unknown) {
      settlement.onEvent({ event: "sessions.changed", payload });
      await vi.advanceTimersByTimeAsync(0);
    },
    observe(this: void, key: string, previousManifestRef?: string) {
      waits.push(
        settlement.wait(client, key, controller.signal, previousManifestRef).then(
          () => outcomes.set(key, "settled"),
          (error: unknown) => outcomes.set(key, error),
        ),
      );
    },
  };
}

it("gates inventory on current hello, propagates failures, and retires removed nodes", async () => {
  const operator = new GatewayClient({});
  transport.clients.at(-1)!.request.mockResolvedValue({
    nodes: [
      {
        nodeId: "paired-fixture-node",
        approvalState: "approved",
        connected: true,
        paired: true,
        sessionHost: true,
      },
    ],
  });
  const root = tempDirs.make("openclaw-paired-node-readiness-");
  const host = await createPairedNodeWorkerHost({
    gateway: {
      wsUrl: "ws://fixture.invalid",
      token: "fixture-token",
      runtimeEnv: { OPENCLAW_STATE_DIR: "gateway-fixture-state" },
    },
    operator,
    root,
  });
  const client = transport.clients.at(-1)!;
  onTestFinished(() => host.stop());
  expect(client.options.env?.OPENCLAW_STATE_DIR).toBe(path.join(root, "node-state"));
  expect(client.request).toHaveBeenCalledOnce();
  const inventory = parseNodeRunnerInventoryDeclaration(client.request.mock.calls[0]?.[1]);
  if (!inventory || !("workerHost" in inventory)) {
    throw new Error("paired worker fixture did not publish a worker host inventory");
  }
  expect(resolveNodeWorkerExecutionIssue(inventory.workerHost)).toBeUndefined();
  client.request.mockClear();
  client.options.onClose?.(1012, "Gateway replacement");
  expect(client.connected).toBe(true);
  const publication = host.publishInventory();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.request).not.toHaveBeenCalled();

  client.hello();
  client.options.onClose?.(1012, "hello retired before publication");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.request).not.toHaveBeenCalled();

  client.hello();
  await publication;
  expect(client.request).toHaveBeenCalledExactlyOnceWith(
    NODE_RUNNER_INVENTORY_UPDATE_METHOD,
    expect.objectContaining({ workerHost: expect.objectContaining({ enabled: true }) }),
  );

  const rejected = new Error("inventory rejected");
  client.request.mockRejectedValueOnce(rejected);
  await expect(host.publishInventory()).rejects.toBe(rejected);
  expect(client.request).toHaveBeenCalledTimes(2);

  const replacement = host.connect();
  await expect(host.publishInventory()).rejects.toThrow("disconnected");
  await replacement;
  const replacementClient = transport.clients.at(-1)!;
  expect(replacementClient).not.toBe(client);
  expect(client.request).toHaveBeenCalledTimes(2);
  expect(replacementClient.request).toHaveBeenCalledOnce();

  replacementClient.options.onClose?.(1012, "disconnect while waiting for hello");
  const pending = expect(host.publishInventory()).rejects.toThrow("disconnected");
  await host.disconnect();
  client.hello();
  replacementClient.hello();
  await pending;
  expect(client.request).toHaveBeenCalledTimes(2);
  expect(replacementClient.request).toHaveBeenCalledOnce();
  await expect(host.publishInventory()).rejects.toThrow("disconnected");

  for (const reason of ["device removed", "client invalidated: device-pair-removed"]) {
    await host.connect();
    const removedClient = transport.clients.at(-1)!;
    const stopRemoved = vi.spyOn(removedClient, "stop");
    removedClient.options.onClose?.(4001, reason);
    const removedPublication = host.publishInventory();
    removedClient.hello();
    await expect(removedPublication).rejects.toThrow("disconnected");
    expect(stopRemoved).toHaveBeenCalledOnce();
    expect(removedClient.request).toHaveBeenCalledOnce();
    await expect(host.publishInventory()).rejects.toThrow("disconnected");

    await host.connect();
    const reconnectedClient = transport.clients.at(-1)!;
    const stopReconnected = vi.spyOn(reconnectedClient, "stop");
    removedClient.options.onClose?.(4001, reason);
    removedClient.hello();
    await host.publishInventory();
    expect(stopReconnected).not.toHaveBeenCalled();
    expect(reconnectedClient.request).toHaveBeenCalledTimes(2);
    expect(removedClient.request).toHaveBeenCalledOnce();
  }
});

it.each(["keyless", "keyed"] as const)("refreshes waits on %s notices", async (notice) => {
  const { outcomes, client, observe, changed, onEvent } = settlementFixture();
  const keys = ["agent:qa:workspace-a", "agent:qa:workspace-b"];
  const placements = new Map(keys.map((key) => [key, true]));
  client.request.mockImplementation(async (method: string, { key }: { key: string }) => {
    expect(method).toBe("sessions.describe");
    return workspace(placements.get(key));
  });
  keys.forEach((key) => observe(key));
  await vi.advanceTimersByTimeAsync(0);
  expect(outcomes.size).toBe(0);
  placements.set(keys[0]!, false);
  onEvent({ event: "chat", payload: {} });
  await changed(null);
  expect(outcomes.size).toBe(0);
  await changed(notice === "keyed" ? { sessionKey: keys[0] } : {});
  expect([...outcomes]).toEqual([[keys[0], "settled"]]);
  await changed({ session: { key: keys[1], ...workspace(false).session } });
  expect([...outcomes]).toEqual(keys.map((key) => [key, "settled"]));
});

it("waits for this turn's manifest before accepting a settled placement", async () => {
  const { outcomes, client, observe, changed } = settlementFixture();
  const key = "agent:qa:workspace-next-turn";
  client.request.mockResolvedValue(workspace(false, "before"));
  observe(key, "before");
  await vi.advanceTimersByTimeAsync(0);
  expect(outcomes.get(key)).toBeUndefined();
  await changed({ sessionKey: key, ...workspace(false, "before") });
  expect(outcomes.get(key)).toBeUndefined();
  await changed({ sessionKey: key, session: { placement: { state: "active" } } });
  expect(outcomes.get(key)).toBeUndefined();
  await changed({ sessionKey: key, ...workspace(true, "after") });
  expect(outcomes.get(key)).toBeUndefined();
  await changed({ sessionKey: key, ...workspace(false, "after") });
  expect(outcomes.get(key)).toBe("settled");
});

it.each(["initial", "refresh"] as const)("retires failed %s describes", async (failureAt) => {
  const settlement = settlementFixture();
  const { controller, outcomes, client, observe, changed } = settlement;
  const key = "agent:qa:workspace-error";
  const failure = new Error("synthetic describe failure");
  if (failureAt === "refresh") {
    client.request.mockResolvedValueOnce(workspace(true));
  }
  client.request.mockRejectedValue(failure);
  observe(key);
  await vi.advanceTimersByTimeAsync(0);
  if (failureAt === "refresh") {
    expect(outcomes.get(key)).toBeUndefined();
    await changed({});
  }
  expect(outcomes.get(key)).toBe(failure);
  client.request.mockResolvedValue(workspace());
  await expect(settlement.wait(client, key, controller.signal)).resolves.toBeUndefined();
});

it.each(["snapshot", "abort"] as const)("handles pending %s", async (completion) => {
  const { controller, outcomes, client, observe, onEvent } = settlementFixture();
  const key = "agent:qa:workspace-pending";
  const read = createDeferred<ReturnType<typeof workspace>>();
  client.request.mockReturnValue(read.promise);
  const stopped = new Error("synthetic test abort");
  observe(key);
  try {
    if (completion === "snapshot") {
      onEvent({
        event: "sessions.changed",
        payload: { sessionKey: key, ...workspace() },
      });
    } else {
      controller.abort(stopped);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes.get(key)).toBe(completion === "snapshot" ? "settled" : stopped);
  } finally {
    read.resolve(workspace(false));
    controller.abort(stopped);
  }
});
