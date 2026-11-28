import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { prepareDevicePairingBinding } from "../../infra/device-pairing-binding.js";
import { resolveNodePairingState, type PairedDevice } from "../../infra/device-pairing.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import {
  getNodeWorkerSupervisorTransport,
  updateNodeRunnerInventory,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { createDevicePairingNodeSnapshot, pairedNodeDevice } from "./environments.test-support.js";
import { nodeEventHandlers } from "./nodes.event.js";
import {
  expectNodeFailure,
  expectNodeReply,
  invokeNodeRequest,
} from "./nodes.invoke.test-support.js";
import { nodeReadHandlers } from "./nodes.read.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  pairing: vi.fn(),
  stats: vi.fn(),
  localId: vi.fn(),
}));

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>();
  return { ...actual, readDevicePairingNodeSnapshot: mocks.snapshot };
});

// mock-isolation: Node inventory uses a synthetic local identity, not the host identity.
vi.mock("../../node-host/local-id.js", () => ({
  resolveLocalNodeId: mocks.localId,
}));

vi.mock("../../infra/device-pairing-node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/device-pairing-node.js")>();
  return {
    ...actual,
    listNodePairing: mocks.pairing,
    recordPairedNodeHostStats: mocks.stats,
  };
});

function createPairedNode(nodeId: string) {
  return pairedNodeDevice(nodeId, { displayName: nodeId, caps: [], commands: [] });
}
let registry: NodeRegistry;
beforeEach(() => {
  registry = new NodeRegistry();
  mocks.localId.mockResolvedValue(undefined);
});
afterEach(() => mocks.stats.mockReset());

function registerNode(pairedNode: PairedDevice, connId = `connection-${pairedNode.deviceId}`) {
  const pairingState = expectDefined(
    resolveNodePairingState(pairedNode),
    `${pairedNode.deviceId} pairing state`,
  );
  const client = createWorkerSupervisorNodeClient(connId);
  client.connect.device!.id = pairedNode.deviceId;
  client.connect.client.displayName = pairedNode.deviceId;
  client.connect.commands = [];
  registry.register(client, {
    pairingIdentity: pairingState.identity.key,
    ...(pairingState.generation ? { pairingGeneration: pairingState.generation.key } : {}),
  });
  onTestFinished(() => {
    registry.unregister(client.connId);
  });
  return client;
}

function invoke(
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"] = {
    connect: { scopes: ["operator.read"] },
  } as GatewayRequestHandlerOptions["client"],
) {
  const handlers = method === "node.event" ? nodeEventHandlers : nodeReadHandlers;
  return invokeNodeRequest(
    expectDefined(handlers[method], method),
    {
      nodeRegistry: registry,
      broadcast: vi.fn(),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestHandlerOptions["context"],
    client,
    method,
    params,
  );
}

async function request(
  method = "node.list",
  params: Record<string, unknown> = {},
  client?: GatewayRequestHandlerOptions["client"],
) {
  const respond = await invoke(method, params, client);
  expectNodeReply(respond, expect.anything());
  return respond.mock.calls[0]![1];
}

const publishPairing = (paired: PairedDevice[]) =>
  mocks.snapshot.mockResolvedValue(createDevicePairingNodeSnapshot(paired));
const sampleStats = { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes: 4096 };

it("uses current node bindings when pairing publications replace historical roles", async () => {
  const current = createPairedNode("current-node");
  const revoked = createPairedNode("revoked-node");
  const operator = createPairedNode("operator-device");
  for (const device of [current, revoked, operator]) {
    delete device.nodeSurface;
  }
  revoked.tokens!.node!.revokedAtMs = 2;
  operator.roles = ["operator"];
  operator.tokens = {
    operator: { token: "test-operator-token", role: "operator", scopes: [], createdAtMs: 1 },
  };
  const paired = [current, revoked, operator];
  publishPairing(paired);
  const readIds = async () => (await request()).nodes.map((node: NodeListNode) => node.nodeId);
  expect(await readIds()).toEqual(["current-node"]);
  current.tokens!.node!.revokedAtMs = 3;
  publishPairing(paired);
  expect(await readIds()).toEqual([]);
});

it("shares immutable catalog rows until pairing or live node facts change", async () => {
  const paired = createPairedNode("cached-node");
  registry = new NodeRegistry({
    resolveCurrentPairingState: async () =>
      prepareDevicePairingBinding(paired.deviceId, paired).binding ?? undefined,
  });
  const client = registerNode(paired);
  publishPairing([paired]);
  const admin = {
    connect: { scopes: ["operator.admin"] },
  } as GatewayRequestHandlerOptions["client"];
  const read = async (): Promise<NodeListNode> => (await request("node.list", {}, admin)).nodes[0];
  const initial = await read();
  expect(initial).toMatchObject({ nodeId: "cached-node", connected: true, commands: [] });
  expect(await read()).toBe(initial);
  expect(Object.isFrozen(initial)).toBe(true);
  expect(Object.isFrozen(initial.commands)).toBe(true);

  registry.updateHostStats({
    nodeId: paired.deviceId,
    connId: client.connId,
    stats: sampleStats,
    observedAtMs: 100,
  });
  const stats = await read();
  expect(stats).not.toBe(initial);
  expect(stats.hostStats).toMatchObject({ memoryFreeBytes: 4096, updatedAtMs: 100 });
  expect(initial.hostStats).toBeUndefined();
  expect(await read()).toBe(stats);

  const transport = getNodeWorkerSupervisorTransport(registry);
  const publishCapacity = (available: number) => {
    expect(
      updateNodeRunnerInventory({
        registry,
        nodeId: paired.deviceId,
        connId: client.connId,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: {
            enabled: true,
            capacity: { total: 2, available },
            bundleRetention: 1,
            bundleStatus: 1,
          },
        },
      }),
    ).toEqual({ changed: true });
  };
  publishCapacity(1);
  const proof = expectDefined(
    await transport.getCurrentNode(paired.deviceId),
    "current node proof",
  );
  expect(
    transport.acceptBundleStatus?.(proof, {
      bundleHash: "a".repeat(64),
      status: { status: "installed", version: "1" },
    }),
  ).toBe(true);
  const inventory = await read();
  expect(inventory.workerSlots).toEqual({ total: 2, available: 1 });
  expect(inventory.workerBundle).toEqual({ status: "installed", version: "1" });
  const described = await request("node.describe", { nodeId: paired.deviceId }, admin);
  expect(described).toMatchObject({
    nodeId: paired.deviceId,
    workerSlots: { total: 2, available: 1 },
    workerBundle: { status: "installed", version: "1" },
    sessionHost: true,
  });
  for (const projection of [inventory, described]) {
    expect(JSON.stringify(projection)).not.toContain("bundleHash");
  }
  expect(Object.isFrozen(inventory.workerSlots)).toBe(true);
  expect(Object.isFrozen(inventory.workerBundle)).toBe(true);
  expect(() => Object.assign(inventory.workerSlots!, { available: 0 })).toThrow();
  expect(() => Object.assign(inventory.workerBundle!, { status: "missing" })).toThrow();
  expect((await transport.getCurrentNode(paired.deviceId))?.workerHost.capacity.available).toBe(1);
  expect(transport.getBundleStatus?.(paired.deviceId)?.status.status).toBe("installed");
  publishCapacity(0);
  const full = await read();
  expect(full.workerSlots?.available).toBe(0);
  expect(inventory.workerSlots?.available).toBe(1);
  expect(await read()).toBe(full);

  paired.nodeSurface!.displayName = "Renamed node";
  publishPairing([paired]);
  const renamed = await read();
  expect(renamed.displayName).toBe("Renamed node");
  expect(await read()).toBe(renamed);

  registry.unregister(client.connId);
  const offline = await read();
  expect(offline).toMatchObject({ connected: false, displayName: "Renamed node" });
  expect(offline.hostStats).toBeUndefined();
  expect(await read()).toBe(offline);

  publishPairing([]);
  expect(await read()).toBeUndefined();
});

it("retains received stats after replacement and rejects the retired connection", async () => {
  const pairedNode = createPairedNode("stats-node");
  registry = new NodeRegistry({
    persistHostStats: mocks.stats,
    resolveCurrentPairingState: async () =>
      prepareDevicePairingBinding(pairedNode.deviceId, pairedNode).binding ?? undefined,
  });
  const registered = registerNode(pairedNode);
  pairedNode.nodeSurface!.lastHostStats = {
    ...sampleStats,
    memoryFreeBytes: 1024,
    updatedAtMs: 50_000,
  };
  mocks.stats.mockImplementation(async ({ hostStats }) => {
    pairedNode.nodeSurface!.lastHostStats = structuredClone(hostStats);
    return true;
  });
  mocks.snapshot.mockImplementation(async () => createDevicePairingNodeSnapshot([pairedNode]));
  const sendStats = () =>
    invoke("node.event", { event: "node.host.stats", payload: sampleStats }, registered);
  const readNode = async (): Promise<NodeListNode> => (await request()).nodes[0];

  expectNodeReply(await sendStats(), {
    ok: true,
    event: "node.host.stats",
    handled: true,
    reason: "updated",
  });
  const hostStats = registry.get(pairedNode.deviceId)!.hostStats!;
  expect(hostStats).toEqual({ ...sampleStats, updatedAtMs: expect.any(Number) });
  const connected = await readNode();
  expect(connected).toMatchObject({ connected: true, hostStats });
  expect(connected.hostStats).not.toBe(registry.get(pairedNode.deviceId)?.hostStats);
  const replacement = registerNode(pairedNode, "replacement");
  const pairingState = resolveNodePairingState(pairedNode)!;
  expect(registry.unregister(registered.connId)).toBeNull();
  expect(await readNode()).toMatchObject({ connected: true });
  expect(await readNode()).not.toHaveProperty("hostStats");
  expectNodeFailure(await sendStats(), { details: { code: "PAIRING_CHANGED" } });
  registry.unregister(replacement.connId);
  const offline = await readNode();
  expect(offline).toMatchObject({ connected: false, hostStats });
  expect(offline.hostStats).not.toBe(pairedNode.nodeSurface!.lastHostStats);
  expect(mocks.stats).toHaveBeenCalledExactlyOnceWith({
    nodeId: pairedNode.deviceId,
    hostStats,
    expectedPairingGeneration: {
      nodeId: pairedNode.deviceId,
      key: pairingState.generation!.key,
    },
  });
});

it("preserves Gateway-local ownership across list and describe", async () => {
  const localNodeId = "local-node",
    remoteNodeId = "remote-node";
  const pairedNodes = [localNodeId, remoteNodeId].map(createPairedNode);
  const [, remoteClient] = pairedNodes.map((paired) => registerNode(paired));
  expect(
    updateNodeRunnerInventory({
      registry,
      nodeId: remoteNodeId,
      connId: remoteClient?.connId,
      declaration: { protocolFeatures: ["node-worker-supervisor-v1"] },
    }),
  ).toEqual({ changed: true });
  publishPairing(pairedNodes);
  mocks.localId.mockResolvedValue(localNodeId);

  const { nodes }: { nodes: NodeListNode[] } = await request();
  expect(nodes.filter((node) => node.gatewayLocal)).toEqual([
    expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
  ]);
  const [local, remote] = [localNodeId, remoteNodeId].map((id) =>
    nodes.find((node) => node.nodeId === id),
  );
  expect(remote).not.toHaveProperty("gatewayLocal");
  expect(local).not.toHaveProperty("issues");
  expect(remote?.issues).toEqual([NODE_RUNNER_UPDATE_REQUIRED_ISSUE]);

  expect(await request("node.describe", { nodeId: localNodeId })).toEqual(
    expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
  );
  expect(await request("node.describe", { nodeId: remoteNodeId })).toMatchObject({
    issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
  });
});

it("names the pending capability surface approval when inventory publication lacks a pairing generation", async () => {
  const nodeId = "pending-surface-node";
  const pairedNode = createPairedNode(nodeId);
  delete pairedNode.nodeSurface;
  const client = registerNode(pairedNode);
  mocks.pairing.mockResolvedValue({
    pending: [{ requestId: "surface-request-1", nodeId, ts: 1 }],
    paired: [],
  });

  const respond = await invoke(
    "node.runnerInventory.update",
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
    },
    client,
  );

  expectNodeFailure(respond, {
    message: expect.stringContaining("openclaw nodes approve surface-request-1"),
  });
});
