import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { projectPairedDeviceNodeBindings } from "../../infra/device-pairing-node-state.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
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
import { pairedNodeDevice } from "./environments.test-support.js";
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

vi.mock("../../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing.js")>()),
  listDevicePairing: vi.fn(),
}));

const RETIRED_WORKER_RUNS = { retired: true } as const;
const AVAILABLE_CAPACITY = { total: 2, available: 2 } as const;
const FULL_CAPACITY = { total: 2, available: 0 } as const;

function runnerInventoryOptions(params: {
  nodeRegistry: NodeRegistry;
  client: GatewayWsClient;
  declaration: unknown;
}): GatewayRequestHandlerOptions {
  return {
    req: {
      type: "req",
      id: "req-1",
      method: "node.runnerInventory.update",
      params: params.declaration,
    },
    params: params.declaration,
    client: params.client as never,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: { nodeRegistry: params.nodeRegistry, logGateway: { warn: vi.fn() } },
  } as unknown as GatewayRequestHandlerOptions;
}

const runnerInventoryHandler = expectDefined(
  nodeHandlers["node.runnerInventory.update"],
  'nodeHandlers["node.runnerInventory.update"] test invariant',
);

async function publishInventory(
  nodeRegistry: NodeRegistry,
  client: GatewayWsClient,
  declaration: unknown,
) {
  const options = runnerInventoryOptions({ nodeRegistry, client, declaration });
  await runnerInventoryHandler(options);
  return options;
}

const availableHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
} as const;

const fullHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: FULL_CAPACITY, bundlePrewarm: 1 },
} as const;

const retainedHost = {
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: {
    enabled: true,
    capacity: AVAILABLE_CAPACITY,
    bundlePrewarm: 1,
    bundleRetention: 1,
    bundleStatus: 1,
  },
} as const;

function createCurrentRunner() {
  const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
  const transport = runtime.nodeWorkerSupervisorTransport;
  const client = createWorkerSupervisorNodeClient();
  runtime.nodeRegistry.register(client, {
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
  });
  return { runtime, client, transport };
}

beforeEach(() => {
  updatePairedNodeSessionHostMock.mockReset();
  updatePairedNodeSessionHostMock.mockResolvedValue(true);
});

describe("nodeHandlers node.runnerInventory.update", () => {
  it.each([GATEWAY_CLIENT_IDS.NODE_HOST, GATEWAY_CLIENT_IDS.MACOS_APP])(
    "publishes explicit runner consent and launch capacity for authenticated %s",
    async (clientId) => {
      const inventoryChanged = vi.fn();
      const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
      const transport = runtime.nodeWorkerSupervisorTransport;
      setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
      const client = createWorkerSupervisorNodeClient();
      const sent: string[] = [];
      client.socket.send = (frame) => {
        if (typeof frame !== "string") {
          throw new Error("expected a JSON text frame");
        }
        sent.push(frame);
      };
      client.connect.client.id = clientId;
      runtime.nodeRegistry.register(client, {
        pairingIdentity: "identity-1",
        pairingGeneration: "generation-1",
      });
      const opts = await publishInventory(runtime.nodeRegistry, client, availableHost);

      expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
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
      expect(
        collectNodeCatalogRuntimeState(runtime.nodeRegistry, [
          { nodeId: "node-1", connId: "conn-1" },
        ]).workerSlotsByNodeId,
      ).toEqual(new Map([["node-1", AVAILABLE_CAPACITY]]));
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
      expect(runtime.nodeRegistry.get("node-1")?.clientId).toBe(clientId);
      runtime.nodeRegistry.handleInvokeResult({
        id: frame.payload.id,
        nodeId: "node-1",
        connId: "conn-1",
        ok: true,
        payloadJSON: "{}",
      });
      await expect(invocation).resolves.toMatchObject({ ok: true });
      runtime.nodeRegistry.unregister("conn-1");
    },
  );

  it("stores bundle status only for the exact current node proof", async () => {
    const { runtime, client, transport } = createCurrentRunner();
    await publishInventory(runtime.nodeRegistry, client, retainedHost);
    const [proof] = await transport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current node proof");
    }

    expect(
      transport.acceptBundleStatus?.(proof, {
        bundleHash: "a".repeat(64),
        status: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(true);
    expect(transport.getBundleStatus?.("node-1")).toEqual({
      bundleHash: "a".repeat(64),
      status: { status: "installed", version: "2026.8.9" },
    });
    const catalog = collectNodeCatalogRuntimeState(runtime.nodeRegistry, [
      { nodeId: "node-1", connId: "conn-1" },
    ]);
    expect(catalog.workerBundleByNodeId).toEqual(
      new Map([["node-1", { status: "installed", version: "2026.8.9" }]]),
    );
    const bundle = expectDefined(catalog.workerBundleByNodeId.get("node-1"), "projected bundle");
    bundle.status = "missing";
    expect(transport.getBundleStatus?.("node-1")?.status).toEqual({
      status: "installed",
      version: "2026.8.9",
    });

    expect(
      runtime.nodeRegistry.updateSurface(
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
    expect(
      transport.acceptBundleStatus?.(proof, {
        bundleHash: "b".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(false);
    expect(
      collectNodeCatalogRuntimeState(runtime.nodeRegistry, [{ nodeId: "node-1", connId: "conn-1" }])
        .workerBundleByNodeId,
    ).toEqual(new Map());

    await publishInventory(runtime.nodeRegistry, client, retainedHost);
    const [currentProof] = await transport.listCurrentNodes();
    if (!currentProof) {
      throw new Error("expected promoted node proof");
    }
    expect(
      transport.acceptBundleStatus?.(currentProof, {
        bundleHash: "b".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(true);
    await publishInventory(runtime.nodeRegistry, client, availableHost);
    expect(
      transport.acceptBundleStatus?.(currentProof, {
        bundleHash: "c".repeat(64),
        status: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(false);
    expect(
      collectNodeCatalogRuntimeState(runtime.nodeRegistry, [{ nodeId: "node-1", connId: "conn-1" }])
        .workerBundleByNodeId,
    ).toEqual(new Map());

    runtime.nodeRegistry.unregister("conn-1");
    expect(
      collectNodeCatalogRuntimeState(runtime.nodeRegistry, [{ nodeId: "node-1", connId: "conn-1" }])
        .workerBundleByNodeId,
    ).toEqual(new Map());
  });

  it("retains the supervisor proof while full but rejects new launches", async () => {
    const { runtime, client, transport } = createCurrentRunner();
    const publish = async (declaration: unknown) => {
      const opts = await publishInventory(runtime.nodeRegistry, client, declaration);
      expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
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
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("requires a fresh current-generation publication after same-connection promotion", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const transport = runtime.nodeWorkerSupervisorTransport;
    const client = createWorkerSupervisorNodeClient();
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-1" });
    const opts = await publishInventory(runtime.nodeRegistry, client, fullHost);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);

    expect(
      runtime.nodeRegistry.updateSurface(
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

    const retry = await publishInventory(runtime.nodeRegistry, client, fullHost);
    expect(retry.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    await expect(transport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        pairingGeneration: "generation-1",
        workerHost: { enabled: true, capacity: FULL_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("persists false for current disabled and empty publications", async () => {
    const { runtime, client } = createCurrentRunner();

    await publishInventory(runtime.nodeRegistry, client, {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: false },
    });
    await publishInventory(runtime.nodeRegistry, client, { protocolFeatures: [] });

    expect(
      updatePairedNodeSessionHostMock.mock.calls.map(([params]) => params.sessionHost),
    ).toEqual([false, false]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("keeps a failed session host available for desktop while refusing session placement", async () => {
    const config = { gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry({ getConfig: () => config }));
    const transport = runtime.nodeWorkerSupervisorTransport;
    const client = createWorkerSupervisorNodeClient();
    client.connect.commands = [NODE_DESKTOP_STREAM_COMMAND];
    const paired = pairedNodeDevice("node-1", { commands: [NODE_DESKTOP_STREAM_COMMAND] });
    const binding = expectDefined(
      projectPairedDeviceNodeBindings([paired]).get("node-1"),
      "paired node binding",
    );
    const node = runtime.nodeRegistry.register(client, {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    });
    vi.mocked(listDevicePairing).mockResolvedValue({ pending: [], paired: [paired] });
    const device = createDeviceWorkerRuntime({ getPairedDevice: async () => paired });
    device.bindNodeTransport(transport);
    const service = {};
    bindDeviceWorkerAvailability(service, device.resolveAvailability);
    const inventoryChanged = vi.fn();
    setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
    const connected = [node];
    try {
      const reason = "state directory /srv/node is group-writable; run chmod go-w /srv/node";
      inventoryChanged.mockClear();
      const opts = await publishInventory(runtime.nodeRegistry, client, {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: false, reason },
      });
      expect(opts.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
      expect(inventoryChanged).toHaveBeenCalledWith("node-1", {
        inventoryChanged: true,
        availabilityChanged: false,
      });
      const issue = { code: "worker-host-unavailable", message: reason };
      expect(transport.getIssue?.("node-1")).toEqual(issue);
      const catalog = collectNodeCatalogRuntimeState(runtime.nodeRegistry, connected);
      expect(catalog.issuesByNodeId.get("node-1")).toEqual([issue]);
      expect(catalog.sessionHostNodeIds.size).toBe(0);
      expect(catalog.workerSlotsByNodeId.size).toBe(0);
      await expect(transport.listCurrentNodes()).resolves.toEqual([]);
      for (const method of ["environments.list", "environments.status"] as const) {
        const respond = vi.fn();
        await environmentsHandlers[method]?.({
          params: method === "environments.list" ? {} : { environmentId: "node:node-1" },
          respond,
          context: { nodeRegistry: runtime.nodeRegistry, getRuntimeConfig: () => config },
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

      await publishInventory(runtime.nodeRegistry, client, availableHost);
      expect(transport.getIssue?.("node-1")).toBeUndefined();
      expect(
        collectNodeCatalogRuntimeState(runtime.nodeRegistry, connected).issuesByNodeId.size,
      ).toBe(0);
    } finally {
      runtime.nodeRegistry.unregister("conn-1");
    }
    expect(transport.getIssue?.("node-1")).toBeUndefined();
  });

  it("returns a retryable failure when durable consent does not commit", async () => {
    const { runtime, client } = createCurrentRunner();
    updatePairedNodeSessionHostMock.mockRejectedValueOnce(new Error("database busy"));
    const first = await publishInventory(runtime.nodeRegistry, client, availableHost);

    expect(first.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("retry") }),
    );

    const retry = await publishInventory(runtime.nodeRegistry, client, availableHost);
    expect(retry.respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
    expect(updatePairedNodeSessionHostMock).toHaveBeenCalledTimes(2);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("rejects durable consent after a same-generation connection replacement", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const client = createWorkerSupervisorNodeClient("conn-original");
    runtime.nodeRegistry.register(client, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const replacement = createWorkerSupervisorNodeClient("conn-replacement");
    updatePairedNodeSessionHostMock.mockImplementationOnce(async (params) => {
      runtime.nodeRegistry.register(replacement, {
        pairingIdentity: "identity-1",
        pairingGeneration: "generation-1",
      });
      return params.isConnectionCurrent();
    });
    const publication = await publishInventory(runtime.nodeRegistry, client, availableHost);

    expect(publication.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("retry") }),
    );
    runtime.nodeRegistry.unregister("conn-replacement");
  });

  it("keeps retired v1 inventory diagnostic-only until disconnect and v6 reconnect", async () => {
    const inventoryChanged = vi.fn();
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const transport = runtime.nodeWorkerSupervisorTransport;
    setNodeRunnerStateChangedListener(runtime.nodeRegistry, inventoryChanged);
    const legacyClient = createWorkerSupervisorNodeClient("conn-v1");
    runtime.nodeRegistry.register(legacyClient, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const legacy = await publishInventory(runtime.nodeRegistry, legacyClient, {
      protocolFeatures: ["node-worker-supervisor-v1"],
      workerRuns: RETIRED_WORKER_RUNS,
    });

    expect(legacy.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw update"),
      }),
    );
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

    runtime.nodeRegistry.unregister("conn-v1");
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(inventoryChanged).toHaveBeenCalledTimes(2);

    const currentClient = createWorkerSupervisorNodeClient("conn-v6");
    runtime.nodeRegistry.register(currentClient, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    await publishInventory(runtime.nodeRegistry, currentClient, availableHost);
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    await expect(transport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-v6",
        workerHost: { enabled: true, capacity: AVAILABLE_CAPACITY, bundlePrewarm: 1 },
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-v6");
  });

  it("rejects malformed inventory without changing private eligibility", async () => {
    const { runtime, client, transport } = createCurrentRunner();
    const opts = await publishInventory(runtime.nodeRegistry, client, {
      protocolFeatures: [],
      extra: true,
    });
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(updatePairedNodeSessionHostMock).not.toHaveBeenCalled();
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-1");
  });

  it("rejects a stale connection without replacing the current session proof", async () => {
    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const transport = runtime.nodeWorkerSupervisorTransport;
    const current = createWorkerSupervisorNodeClient("conn-current");
    runtime.nodeRegistry.register(current, {
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
    });
    const stale = createWorkerSupervisorNodeClient("conn-stale");
    const opts = await publishInventory(runtime.nodeRegistry, stale, availableHost);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    await expect(transport.listCurrentNodes()).resolves.toEqual([]);
    runtime.nodeRegistry.unregister("conn-current");
  });
});
