import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { projectPairedDeviceNodeBindings } from "../../infra/device-pairing-node-state.js";
import type { PairedDevice } from "../../infra/device-pairing.js";
import { resolveNodePairingState } from "../../infra/device-pairing.js";
import {
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { pairedNodeDevice } from "./environments.test-support.js";
import { nodeEventHandlers } from "./nodes.event.js";
import { nodeReadHandlers } from "./nodes.read.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { pairingSnapshot, listNodePairingMock, recordHostStatsMock, resolveLocalNodeIdMock } =
  vi.hoisted(() => ({
    pairingSnapshot: { paired: [] as PairedDevice[] },
    listNodePairingMock: vi.fn(),
    recordHostStatsMock: vi.fn(),
    resolveLocalNodeIdMock: vi.fn(),
  }));

vi.mock("../../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _baseDir: string | undefined,
    prepare: (paired: readonly PairedDevice[]) => { start: () => T | Promise<T> } | undefined,
  ) => prepare(pairingSnapshot.paired)?.start(),
}));

vi.mock("../../node-host/local-id.js", () => ({
  resolveLocalNodeId: resolveLocalNodeIdMock,
}));

vi.mock("../../infra/device-pairing-node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/device-pairing-node.js")>();
  return {
    ...actual,
    listNodePairing: listNodePairingMock,
    recordPairedNodeHostStats: recordHostStatsMock,
  };
});

function createPairedNode(nodeId: string) {
  return pairedNodeDevice(nodeId, { displayName: nodeId, caps: [], commands: [] });
}

function registerNode(registry: NodeRegistry, pairedNode: PairedDevice) {
  const pairingState = expectDefined(
    resolveNodePairingState(pairedNode),
    `${pairedNode.deviceId} pairing state`,
  );
  const client = createWorkerSupervisorNodeClient(`connection-${pairedNode.deviceId}`);
  client.connect.device!.id = pairedNode.deviceId;
  client.connect.client.displayName = pairedNode.deviceId;
  client.connect.commands = [];
  registry.register(client, {
    pairingIdentity: pairingState.identity.key,
    ...(pairingState.generation ? { pairingGeneration: pairingState.generation.key } : {}),
  });
  return client;
}

async function invoke(
  nodeRegistry: NodeRegistry,
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"] = {
    connect: { scopes: ["operator.read"] },
  } as GatewayRequestHandlerOptions["client"],
) {
  const respond = vi.fn();
  const handlers = method === "node.event" ? nodeEventHandlers : nodeReadHandlers;
  await expectDefined(
    handlers[method],
    method,
  )({
    req: { type: "req", id: method, method, params },
    params,
    client,
    respond,
    isWebchatConnect: () => false,
    context: {
      nodeRegistry,
      broadcast: vi.fn(),
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  return respond;
}

describe("node read projections", () => {
  it("retains received stats after replacement and rejects the retired connection", async () => {
    const pairedNode = createPairedNode("stats-node");
    const { nodeRegistry } = createNodeRegistryRuntime(
      () =>
        new NodeRegistry({
          resolveCurrentPairingState: async () =>
            projectPairedDeviceNodeBindings([pairedNode]).get(pairedNode.deviceId),
        }),
    );
    const registered = registerNode(nodeRegistry, pairedNode);
    const stats = { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes: 4096 };
    const lastHostStats = { ...stats, memoryFreeBytes: 1024, updatedAtMs: 50_000 };
    pairedNode.nodeSurface!.lastHostStats = lastHostStats;
    recordHostStatsMock.mockReset().mockImplementation(async ({ hostStats }) => {
      pairedNode.nodeSurface!.lastHostStats = structuredClone(hostStats);
      return true;
    });
    pairingSnapshot.paired = [pairedNode];
    resolveLocalNodeIdMock.mockResolvedValue(undefined);
    const sendStats = () =>
      invoke(
        nodeRegistry,
        "node.event",
        {
          event: "node.host.stats",
          payload: stats,
        },
        registered,
      );
    const readNode = async (): Promise<NodeListNode> => {
      const respond = await invoke(nodeRegistry, "node.list", {});
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      return respond.mock.calls[0]?.[1].nodes[0];
    };

    try {
      expect(await sendStats()).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          event: "node.host.stats",
          handled: true,
          reason: "updated",
        },
        undefined,
      );
      const hostStats = nodeRegistry.get(pairedNode.deviceId)!.hostStats!;
      expect(hostStats).toEqual({ ...stats, updatedAtMs: expect.any(Number) });
      const connected = await readNode();
      expect(connected).toMatchObject({ connected: true, hostStats });
      expect(connected.hostStats).not.toBe(nodeRegistry.get(pairedNode.deviceId)?.hostStats);
      const replacement = { ...registered, connId: "replacement" };
      const pairingState = resolveNodePairingState(pairedNode)!;
      nodeRegistry.register(replacement, {
        pairingIdentity: pairingState.identity.key,
        pairingGeneration: pairingState.generation!.key,
      });
      // Replacement retires A before its transport close, which cannot save A's stats.
      expect(nodeRegistry.unregister(registered.connId)).toBeNull();
      expect(await readNode()).toMatchObject({ connected: true });
      expect(await readNode()).not.toHaveProperty("hostStats");
      expect(await sendStats()).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "PAIRING_CHANGED" } }),
      );
      nodeRegistry.unregister(replacement.connId);
      const offline = await readNode();
      expect(offline).toMatchObject({ connected: false, hostStats });
      expect(offline.hostStats).not.toBe(pairedNode.nodeSurface!.lastHostStats);
      expect(recordHostStatsMock).toHaveBeenCalledExactlyOnceWith({
        nodeId: pairedNode.deviceId,
        hostStats,
        expectedPairingGeneration: {
          nodeId: pairedNode.deviceId,
          key: pairingState.generation!.key,
        },
      });
    } finally {
      nodeRegistry.unregister(registered.connId);
      nodeRegistry.unregister("replacement");
      recordHostStatsMock.mockReset();
    }
  });

  it("preserves Gateway-local ownership across list and describe", async () => {
    const localNodeId = "local-node";
    const remoteNodeId = "remote-node";
    const pairedNodes = [createPairedNode(localNodeId), createPairedNode(remoteNodeId)];
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const { nodeRegistry } = runtime;
    let remoteClient: ReturnType<typeof registerNode> | undefined;
    for (const pairedNode of pairedNodes) {
      const client = registerNode(nodeRegistry, pairedNode);
      if (pairedNode.deviceId === remoteNodeId) {
        remoteClient = client;
      }
    }
    expect(
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId: remoteNodeId,
        connId: remoteClient?.connId,
        declaration: { protocolFeatures: ["node-worker-supervisor-v1"] },
      }),
    ).toEqual({ changed: true });
    pairingSnapshot.paired = pairedNodes;
    resolveLocalNodeIdMock.mockResolvedValue(localNodeId);

    async function request(method: "node.list" | "node.describe", params: Record<string, unknown>) {
      const respond = await invoke(nodeRegistry, method, params);
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
      return respond.mock.calls[0]?.[1];
    }

    const list = (await request("node.list", {})) as {
      nodes: Array<{ nodeId: string; gatewayLocal?: boolean; issues?: unknown[] }>;
    };
    expect(list.nodes.filter((node) => node.gatewayLocal)).toEqual([
      expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
    ]);
    expect(list.nodes.find((node) => node.nodeId === remoteNodeId)).not.toHaveProperty(
      "gatewayLocal",
    );
    expect(list.nodes.find((node) => node.nodeId === localNodeId)).not.toHaveProperty("issues");
    expect(list.nodes.find((node) => node.nodeId === remoteNodeId)?.issues).toEqual([
      NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    ]);

    await expect(request("node.describe", { nodeId: localNodeId })).resolves.toEqual(
      expect.objectContaining({ nodeId: localNodeId, gatewayLocal: true }),
    );
    await expect(request("node.describe", { nodeId: remoteNodeId })).resolves.toMatchObject({
      issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
    });
  });

  it("names the pending capability surface approval when inventory publication lacks a pairing generation", async () => {
    const nodeId = "pending-surface-node";
    const pairedNode = createPairedNode(nodeId);
    // A pending capability surface means no approved node surface yet, so the
    // registered session carries no pairing generation.
    delete (pairedNode as { nodeSurface?: unknown }).nodeSurface;
    pairedNode.pendingNodeSurface = {
      requestId: "surface-request-1",
      revision: "revision-1",
      ts: 1,
    };
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = registerNode(runtime.nodeRegistry, pairedNode);
    listNodePairingMock.mockResolvedValue({
      pending: [{ requestId: "surface-request-1", nodeId, ts: 1 }],
      paired: [],
    });

    const respond = await invoke(
      runtime.nodeRegistry,
      "node.runnerInventory.update",
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      },
      client,
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("openclaw nodes approve surface-request-1"),
      }),
    );
  });
});
