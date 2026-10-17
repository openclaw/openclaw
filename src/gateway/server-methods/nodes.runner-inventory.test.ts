import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { NODE_WORKER_SUPERVISOR_STATUS_COMMAND } from "../../infra/node-commands.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import {
  collectNodeCatalogRuntimeState,
  createNodeRegistryRuntime,
  setNodeRunnerStateChangedListener,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { resolveDevicePlacementEligibility } from "../worker-environments/device-placement-eligibility.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { environmentsHandlers } from "./environments.js";
import { createDevicePairingNodeSnapshot, pairedNodeDevice } from "./environments.test-support.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type UpdatePairedNodeSessionHostParams = Parameters<
  typeof import("../../infra/device-pairing-node-facts.js").updatePairedNodeSessionHost
>[0];

const updatePairedNodeSessionHostMock = vi.hoisted(() =>
  vi.fn(async (_params: UpdatePairedNodeSessionHostParams): Promise<boolean> => true),
);

vi.mock("../../infra/device-pairing-node-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-node-facts.js")>()),
  updatePairedNodeSessionHost: updatePairedNodeSessionHostMock,
}));

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));

const RETIRED_WORKER_RUNS = { retired: true } as const;
const AVAILABLE_CAPACITY = { total: 2, available: 2 } as const;
const FULL_CAPACITY = { total: 2, available: 0 } as const;

const runnerInventoryHandler = expectDefined(
  nodeHandlers["node.runnerInventory.update"],
  'nodeHandlers["node.runnerInventory.update"] test invariant',
);

async function publishInventory(
  nodeRegistry: NodeRegistry,
  client: GatewayWsClient,
  declaration: unknown,
) {
  const respond = vi.fn();
  await runnerInventoryHandler({
    req: { type: "req", id: "req-1", method: "node.runnerInventory.update", params: declaration },
    params: declaration,
    client,
    isWebchatConnect: () => false,
    respond,
    context: { nodeRegistry, logGateway: { warn: vi.fn() } },
  } as unknown as GatewayRequestHandlerOptions);
  return { respond };
}

const host = (capacity: typeof AVAILABLE_CAPACITY | typeof FULL_CAPACITY) => ({
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity, bundlePrewarm: 1 },
});
const availableHost = host(AVAILABLE_CAPACITY);
const fullHost = host(FULL_CAPACITY);
const retainedHost = {
  ...availableHost,
  workerHost: { ...availableHost.workerHost, bundleRetention: 1, bundleStatus: 1 },
};
const installed = { status: "installed", version: "2026.8.9" } as const;
const bundleStatus = (hash: string, status: "installed" | "missing") => ({
  bundleHash: hash.repeat(64),
  status: status === "installed" ? { ...installed } : { status },
});

function expectPublication(
  publication: { respond: ReturnType<typeof vi.fn> },
  error?: Record<string, unknown>,
) {
  expect(publication.respond).toHaveBeenCalledWith(
    !error,
    error ? undefined : { nodeId: "node-1" },
    error ? expect.objectContaining(error) : undefined,
  );
}

function register(registry: NodeRegistry, client: GatewayWsClient) {
  return registry.register(client, {
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
  });
}

function readCatalog(registry: NodeRegistry) {
  return collectNodeCatalogRuntimeState(registry, [{ nodeId: "node-1", connId: "conn-1" }]);
}

function createCurrentRunner() {
  const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
    createNodeRegistryRuntime(() => new NodeRegistry());
  const client = createWorkerSupervisorNodeClient();
  register(registry, client);
  return { registry, client, transport };
}

beforeEach(() => {
  updatePairedNodeSessionHostMock.mockReset();
  updatePairedNodeSessionHostMock.mockResolvedValue(true);
});

describe("nodeHandlers node.runnerInventory.update", () => {
  it.each([GATEWAY_CLIENT_IDS.MACOS_APP])(
    "publishes explicit runner consent and launch capacity for authenticated %s",
    async (clientId) => {
      const inventoryChanged = vi.fn();
      const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
        createNodeRegistryRuntime(() => new NodeRegistry());
      setNodeRunnerStateChangedListener(registry, inventoryChanged);
      const client = createWorkerSupervisorNodeClient();
      const sent: string[] = [];
      client.socket.send = (frame) => {
        sent.push(frame.toString());
      };
      client.connect.client.id = clientId;
      register(registry, client);
      const opts = await publishInventory(registry, client, availableHost);

      expectPublication(opts);
      expect(updatePairedNodeSessionHostMock).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          sessionHost: true,
          expectedPairingGeneration: { nodeId: "node-1", key: "generation-1" },
        }),
      );
      expect(inventoryChanged).toHaveBeenCalledWith("node-1", {
        inventoryChanged: true,
        availabilityChanged: true,
      });
      await expect(transport.listCurrentNodes()).resolves.toEqual([
        expect.objectContaining({
          clientId,
          nodeId: "node-1",
          connId: "conn-1",
          pairingGeneration: "generation-1",
          workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
        }),
      ]);
      expect(readCatalog(registry).workerSlotsByNodeId).toEqual(
        new Map([["node-1", AVAILABLE_CAPACITY]]),
      );
      const proof = expectDefined(
        (await transport.listCurrentNodes())[0],
        "current authenticated runner proof",
      );
      const invocation = transport.invoke({
        node: proof,
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        isDispatchAuthorized: () => true,
      });
      const frame = JSON.parse(expectDefined(sent[0], "private invoke frame"));
      expect(frame.payload.command).toBe(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
      expect(registry.get("node-1")?.clientId).toBe(clientId);
      registry.handleInvokeResult({
        id: frame.payload.id,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
        payloadJSON: "{}",
      });
      await expect(invocation).resolves.toMatchObject({ ok: true });
      registry.unregister("conn-1");
    },
  );

  it("stores bundle status only for the exact current node proof", async () => {
    const { registry, client, transport } = createCurrentRunner();
    await publishInventory(registry, client, retainedHost);
    const proof = expectDefined((await transport.listCurrentNodes())[0], "current node proof");

    expect(transport.acceptBundleStatus?.(proof, bundleStatus("a", "installed"))).toBe(true);
    expect(transport.getBundleStatus?.("node-1")).toEqual(bundleStatus("a", "installed"));
    const state = readCatalog(registry);
    expect(state.workerBundleByNodeId).toEqual(new Map([["node-1", installed]]));
    const bundle = expectDefined(state.workerBundleByNodeId.get("node-1"), "projected bundle");
    bundle.status = "missing";
    expect(transport.getBundleStatus?.("node-1")?.status).toEqual(installed);

    expect(
      registry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-1",
          expectedPairingGeneration: "generation-1",
          nextPairingGeneration: "generation-2",
        },
      ),
    ).not.toBeNull();
    expect(transport.acceptBundleStatus?.(proof, bundleStatus("b", "missing"))).toBe(false);
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());

    await publishInventory(registry, client, retainedHost);
    const currentProof = expectDefined(
      (await transport.listCurrentNodes())[0],
      "promoted node proof",
    );
    expect(transport.acceptBundleStatus?.(currentProof, bundleStatus("b", "missing"))).toBe(true);
    await publishInventory(registry, client, availableHost);
    expect(transport.acceptBundleStatus?.(currentProof, bundleStatus("c", "installed"))).toBe(
      false,
    );
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());

    registry.unregister("conn-1");
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());
  });

  it("retains the supervisor proof while full but rejects new launches", async () => {
    const { registry, client, transport } = createCurrentRunner();
    const publish = async (declaration: unknown) => {
      const opts = await publishInventory(registry, client, declaration);
      expectPublication(opts);
    };

    await publish(availableHost);
    await publish(fullHost);

    const proof = expectDefined(await transport.getCurrentNode("node-1"), "current runner proof");
    expect(proof.workerHost).toEqual({
      enabled: true,
      capacity: FULL_CAPACITY,
      bundlePrewarm: 1,
    });
    proof.workerHost.capacity.available = 2;
    expect(transport.isCurrent(proof)).toBe(true);
    expect(transport.isCurrent(proof, true)).toBe(false);
    expect((await transport.getCurrentNode("node-1"))?.workerHost.capacity).toEqual(FULL_CAPACITY);
    registry.unregister("conn-1");
  });

  it("requires a fresh current-generation publication after same-connection promotion", async () => {
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient();
    registry.register(client, { pairingIdentity: "identity-1" });
    const opts = await publishInventory(registry, client, fullHost);

    expectPublication(opts, { code: "UNAVAILABLE" });
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);

    expect(
      registry.updateSurface(
        "node-1",
        { commands: ["system.run"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-1",
          nextPairingGeneration: "generation-1",
        },
      ),
    ).not.toBeNull();
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);

    const retry = await publishInventory(registry, client, fullHost);
    expectPublication(retry);
    await expect(transport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: FULL_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    registry.unregister("conn-1");
  });

  it("persists false for current disabled and empty publications", async () => {
    const { registry, client } = createCurrentRunner();

    await publishInventory(registry, client, {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: false },
    });
    await publishInventory(registry, client, { protocolFeatures: [] });

    expect(
      updatePairedNodeSessionHostMock.mock.calls.map(([params]) => params.sessionHost),
    ).toEqual([false, false]);
    registry.unregister("conn-1");
  });

  it("keeps a failed session host available for desktop while refusing session placement", async () => {
    const config = { gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry({ getConfig: () => config }));
    const client = createWorkerSupervisorNodeClient();
    client.connect.commands = [NODE_DESKTOP_STREAM_COMMAND];
    const paired = pairedNodeDevice("node-1", { commands: [NODE_DESKTOP_STREAM_COMMAND] });
    const snapshot = createDevicePairingNodeSnapshot([paired]);
    const binding = expectDefined(snapshot.bindings.get("node-1"), "paired node binding");
    const node = registry.register(client, {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    });
    vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(snapshot);
    const device = createDeviceWorkerRuntime({ getPairedDevice: async () => paired });
    device.bindNodeTransport(transport);
    const service = {};
    bindDeviceWorkerAvailability(service, device.resolveAvailability);
    const inventoryChanged = vi.fn();
    setNodeRunnerStateChangedListener(registry, inventoryChanged);
    const connected = [node];
    try {
      const reason = "state directory /srv/node is group-writable; run chmod go-w /srv/node";
      inventoryChanged.mockClear();
      const opts = await publishInventory(registry, client, {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: false, reason },
      });
      expectPublication(opts);
      expect(inventoryChanged).toHaveBeenCalledWith("node-1", {
        inventoryChanged: true,
        availabilityChanged: false,
      });
      const issue = { code: "worker-host-unavailable", message: reason };
      expect(transport.getIssue?.("node-1")).toEqual(issue);
      const catalog = collectNodeCatalogRuntimeState(registry, connected);
      expect(catalog.issuesByNodeId.get("node-1")).toEqual([issue]);
      expect(catalog.sessionHostNodeIds.size).toBe(0);
      expect(catalog.workerSlotsByNodeId.size).toBe(0);
      await expect(transport.listCurrentNodes()).resolves.toEqual([]);
      for (const method of ["environments.list", "environments.status"] as const) {
        const respond = vi.fn();
        await environmentsHandlers[method]?.({
          params: method === "environments.list" ? {} : { environmentId: "node:node-1" },
          respond,
          context: { nodeRegistry: registry, getRuntimeConfig: () => config },
        } as never);
        const expected = {
          id: "node:node-1",
          status: "available",
          desktop: true,
          sessionHost: false,
          issues: [issue],
        };
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toMatchObject(
          method === "environments.list"
            ? { environments: expect.arrayContaining([expect.objectContaining(expected)]) }
            : expected,
        );
      }
      await expect(
        resolveDevicePlacementEligibility({
          environmentService: service,
          deviceId: "node-1",
          executionMode: "worker-turn",
          requirement: { requiredNodeCommands: [], consumesWorkerSlot: true },
          config,
        }),
      ).resolves.toEqual({
        ok: false,
        error: `device worker node node-1 cannot host sessions: ${reason}`,
      });
      expect(
        updatePairedNodeSessionHostMock.mock.calls.map(([params]) => params.sessionHost),
      ).toEqual([false]);

      await publishInventory(registry, client, availableHost);
      expect(transport.getIssue?.("node-1")).toBeUndefined();
      expect(collectNodeCatalogRuntimeState(registry, connected).issuesByNodeId.size).toBe(0);
    } finally {
      registry.unregister("conn-1");
    }
    expect(transport.getIssue?.("node-1")).toBeUndefined();
  });

  it("returns a retryable failure when durable consent does not commit", async () => {
    const { registry, client } = createCurrentRunner();
    updatePairedNodeSessionHostMock.mockRejectedValueOnce(new Error("database busy"));
    const first = await publishInventory(registry, client, availableHost);

    expectPublication(first, { code: "UNAVAILABLE", message: expect.stringContaining("retry") });

    const retry = await publishInventory(registry, client, availableHost);
    expectPublication(retry);
    expect(updatePairedNodeSessionHostMock).toHaveBeenCalledTimes(2);
    registry.unregister("conn-1");
  });

  it("rejects durable consent after a same-generation connection replacement", async () => {
    const { nodeRegistry: registry } = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient("conn-original");
    register(registry, client);
    const replacement = createWorkerSupervisorNodeClient("conn-replacement");
    updatePairedNodeSessionHostMock.mockImplementationOnce(async (params) => {
      register(registry, replacement);
      return params.isConnectionCurrent();
    });
    const publication = await publishInventory(registry, client, availableHost);

    expectPublication(publication, {
      code: "UNAVAILABLE",
      message: expect.stringContaining("retry"),
    });
    registry.unregister("conn-replacement");
  });

  it("keeps retired v1 inventory diagnostic-only until disconnect and v6 reconnect", async () => {
    const inventoryChanged = vi.fn();
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry());
    setNodeRunnerStateChangedListener(registry, inventoryChanged);
    const legacyClient = createWorkerSupervisorNodeClient("conn-v1");
    register(registry, legacyClient);
    const legacy = await publishInventory(registry, legacyClient, {
      protocolFeatures: ["node-worker-supervisor-v1"],
      workerRuns: RETIRED_WORKER_RUNS,
    });

    expectPublication(legacy, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("openclaw update"),
    });
    expect(inventoryChanged).toHaveBeenLastCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(transport.getIssue?.("node-1")).toEqual(NODE_RUNNER_UPDATE_REQUIRED_ISSUE);
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);
    const forgedProof = {
      nodeId: "node-1",
      connId: "conn-v1",
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
      clientId: "node-host",
      clientMode: "node",
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      commands: ["system.run"],
    } as const;
    expect(transport.isCurrent(forgedProof)).toBe(false);
    await expect(
      transport.invoke({
        node: forgedProof,
        command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PRIVATE_DIALECT_UNAVAILABLE" } });

    registry.unregister("conn-v1");
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(inventoryChanged).toHaveBeenCalledTimes(2);

    const currentClient = createWorkerSupervisorNodeClient("conn-v6");
    register(registry, currentClient);
    await publishInventory(registry, currentClient, availableHost);
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    await expect(transport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-v6",
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    registry.unregister("conn-v6");
  });

  it("rejects malformed inventory without changing private eligibility", async () => {
    const { registry, client, transport } = createCurrentRunner();
    const opts = await publishInventory(registry, client, {
      protocolFeatures: [],
      extra: true,
    });
    expectPublication(opts, { code: "INVALID_REQUEST" });
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);
    registry.unregister("conn-1");
  });

  it("rejects a stale connection without replacing the current session proof", async () => {
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry());
    const current = createWorkerSupervisorNodeClient("conn-current");
    register(registry, current);
    const stale = createWorkerSupervisorNodeClient("conn-stale");
    const opts = await publishInventory(registry, stale, availableHost);

    expectPublication(opts, { code: "INVALID_REQUEST" });
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);
    registry.unregister("conn-current");
  });
});
