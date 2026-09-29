import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClient, type GatewayClientOptions } from "../../../../src/gateway/client.js";
import { NODE_RUNNER_INVENTORY_UPDATE_METHOD } from "../../../../src/infra/node-runner-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { createPairedNodeWorkerHost } from "./paired-node-worker-wire-fixture.js";

const transport = vi.hoisted(() => {
  class TestGatewayClient {
    readonly options: GatewayClientOptions;
    connected = true;
    request = vi.fn(async (_method: string, _params?: unknown) => ({}));
    constructor(options: GatewayClientOptions) {
      this.options = options;
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
    start() {
      this.hello();
    }
    stop() {
      this.options.onClose?.(1000, "fixture stopped");
    }
    async stopAndWait() {
      this.stop();
    }
  }
  const clients: TestGatewayClient[] = [];
  return { GatewayClient: TestGatewayClient, clients };
});

vi.mock("../../../../src/gateway/client.js", () => ({
  ...transport,
  prepareGatewayClientDeviceAuth: async () => {},
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
  try {
    expect(client.options.env?.OPENCLAW_STATE_DIR).toBe(path.join(root, "node-state"));
    expect(client.request).toHaveBeenCalledOnce();
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
  } finally {
    await host.stop();
  }
});
