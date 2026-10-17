import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { NODE_WORKER_SUPERVISOR_STATUS_COMMAND as STATUS_COMMAND } from "../../infra/node-commands.js";
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
import { createWorkerSupervisorNodeClient as nodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type UpdatePairedNodeSessionHostParams = Parameters<
  typeof import("../../infra/device-pairing-node-facts.js").updatePairedNodeSessionHost
>[0];

const persistConsent = vi.hoisted(() =>
  vi.fn(async (_params: UpdatePairedNodeSessionHostParams): Promise<boolean> => true),
);

vi.mock("../../infra/device-pairing-node-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-node-facts.js")>()),
  updatePairedNodeSessionHost: persistConsent,
}));

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));

const AVAILABLE_CAPACITY = { total: 2, available: 2 } as const;
const FULL_CAPACITY = { total: 2, available: 0 } as const;
const RETRY_ERROR = { code: "UNAVAILABLE", message: expect.stringContaining("retry") };

const runnerInventoryHandler = expectDefined(
  nodeHandlers["node.runnerInventory.update"],
  'nodeHandlers["node.runnerInventory.update"] test invariant',
);

async function publishInventory(
  nodeRegistry: NodeRegistry,
  client: GatewayWsClient,
  declaration: unknown,
  error?: Record<string, unknown>,
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
  expect(respond).toHaveBeenCalledWith(
    !error,
    error ? undefined : { nodeId: "node-1" },
    error ? expect.objectContaining(error) : undefined,
  );
}

const host = (capacity: typeof AVAILABLE_CAPACITY | typeof FULL_CAPACITY) => ({
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true as const, capacity, bundlePrewarm: 1 as const },
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

function register(
  registry: NodeRegistry,
  client: GatewayWsClient,
  identity: Parameters<NodeRegistry["register"]>[1] = {
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
  },
) {
  onTestFinished(() => {
    registry.unregister(client.connId);
  });
  return registry.register(client, identity);
}

function readCatalog(registry: NodeRegistry) {
  return collectNodeCatalogRuntimeState(registry, [{ nodeId: "node-1", connId: "conn-1" }]);
}

function promote(registry: NodeRegistry, expected?: string) {
  expect(
    registry.updateSurface(
      "node-1",
      { commands: ["system.run"] },
      {
        expectedConnId: "conn-1",
        expectedPairingIdentity: "identity-1",
        expectedPairingGeneration: expected,
        nextPairingGeneration: expected ? "generation-2" : "generation-1",
      },
    ),
  ).not.toBeNull();
}

function createCurrentRunner(client = nodeClient()) {
  const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
    createNodeRegistryRuntime(() => new NodeRegistry());
  const inventoryChanged = vi.fn();
  setNodeRunnerStateChangedListener(registry, inventoryChanged);
  register(registry, client);
  return {
    registry,
    transport,
    inventoryChanged,
    publish: (declaration: unknown, error?: Record<string, unknown>) =>
      publishInventory(registry, client, declaration, error),
  };
}

async function expectCurrentNodes(
  transport: ReturnType<typeof createCurrentRunner>["transport"],
  ...expected: Record<string, unknown>[]
) {
  await expect(transport.listCurrentNodes()).resolves.toEqual(
    expected.map((node) => expect.objectContaining(node)),
  );
}

beforeEach(() => {
  persistConsent.mockReset();
  persistConsent.mockResolvedValue(true);
});

describe("nodeHandlers node.runnerInventory.update", () => {
  it("publishes explicit runner consent and launch capacity for authenticated macOS", async () => {
    const clientId = GATEWAY_CLIENT_IDS.MACOS_APP;
    const client = nodeClient();
    const send = vi.spyOn(client.socket, "send");
    client.connect.client.id = clientId;
    const { registry, transport, publish, inventoryChanged } = createCurrentRunner(client);
    await publish(availableHost);
    expect(persistConsent).toHaveBeenCalledWith(
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
    await expectCurrentNodes(transport, {
      clientId,
      nodeId: "node-1",
      connId: "conn-1",
      pairingGeneration: "generation-1",
      workerHost: availableHost.workerHost,
    });
    expect(readCatalog(registry).workerSlotsByNodeId).toEqual(
      new Map([["node-1", AVAILABLE_CAPACITY]]),
    );
    const proof = expectDefined(
      (await transport.listCurrentNodes())[0],
      "current authenticated runner proof",
    );
    const invocation = transport.invoke({
      node: proof,
      command: STATUS_COMMAND,
      isDispatchAuthorized: () => true,
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0]));
    expect(frame.payload.command).toBe(STATUS_COMMAND);
    expect(registry.get("node-1")?.clientId).toBe(clientId);
    registry.handleInvokeResult({
      id: frame.payload.id,
      nodeId: "node-1",
      connId: "conn-1",
      ok: true,
      payloadJSON: "{}",
    });
    await expect(invocation).resolves.toMatchObject({ ok: true });
  });

  it("stores bundle status only for the exact current node proof", async () => {
    const { registry, transport, publish } = createCurrentRunner();
    await publish(retainedHost);
    const proof = expectDefined((await transport.listCurrentNodes())[0], "current node proof");

    expect(transport.acceptBundleStatus?.(proof, bundleStatus("a", "installed"))).toBe(true);
    expect(transport.getBundleStatus?.("node-1")).toEqual(bundleStatus("a", "installed"));
    const state = readCatalog(registry);
    expect(state.workerBundleByNodeId).toEqual(new Map([["node-1", installed]]));
    const bundle = expectDefined(state.workerBundleByNodeId.get("node-1"), "projected bundle");
    bundle.status = "missing";
    expect(transport.getBundleStatus?.("node-1")?.status).toEqual(installed);

    promote(registry, "generation-1");
    expect(transport.acceptBundleStatus?.(proof, bundleStatus("b", "missing"))).toBe(false);
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());

    await publish(retainedHost);
    const current = expectDefined((await transport.listCurrentNodes())[0], "promoted node proof");
    expect(transport.acceptBundleStatus?.(current, bundleStatus("b", "missing"))).toBe(true);
    await publish(availableHost);
    expect(transport.acceptBundleStatus?.(current, bundleStatus("c", "installed"))).toBe(false);
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());

    registry.unregister("conn-1");
    expect(readCatalog(registry).workerBundleByNodeId).toEqual(new Map());
  });

  it("retains the supervisor proof while full but rejects new launches", async () => {
    const { transport, publish } = createCurrentRunner();
    await publish(availableHost);
    await publish(fullHost);

    const proof = expectDefined(await transport.getCurrentNode("node-1"), "current runner proof");
    expect(proof.workerHost).toEqual(fullHost.workerHost);
    proof.workerHost.capacity.available = 2;
    expect(transport.isCurrent(proof)).toBe(true);
    expect(transport.isCurrent(proof, true)).toBe(false);
    expect((await transport.getCurrentNode("node-1"))?.workerHost.capacity).toEqual(FULL_CAPACITY);
  });

  it("requires a fresh current-generation publication after same-connection promotion", async () => {
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry());
    const client = nodeClient();
    register(registry, client, { pairingIdentity: "identity-1" });
    await publishInventory(registry, client, fullHost, { code: "UNAVAILABLE" });
    await expectCurrentNodes(transport);

    promote(registry);
    await expectCurrentNodes(transport);

    await publishInventory(registry, client, fullHost);
    await expectCurrentNodes(transport, {
      pairingGeneration: "generation-1",
      workerHost: fullHost.workerHost,
    });
  });

  it("persists false for current disabled and empty publications", async () => {
    const { publish } = createCurrentRunner();

    await publish({
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: false },
    });
    await publish({ protocolFeatures: [] });

    expect(persistConsent.mock.calls.map(([params]) => params.sessionHost)).toEqual([false, false]);
  });

  it("keeps a failed session host available for desktop while refusing session placement", async () => {
    const config = { gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createNodeRegistryRuntime(() => new NodeRegistry({ getConfig: () => config }));
    const client = nodeClient();
    client.connect.commands = [NODE_DESKTOP_STREAM_COMMAND];
    const paired = pairedNodeDevice("node-1", { commands: [NODE_DESKTOP_STREAM_COMMAND] });
    const snapshot = createDevicePairingNodeSnapshot([paired]);
    const binding = expectDefined(snapshot.bindings.get("node-1"), "paired node binding");
    const node = register(registry, client, {
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
    const reason = "state directory /srv/node is group-writable; run chmod go-w /srv/node";
    inventoryChanged.mockClear();
    await publishInventory(registry, client, {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: false, reason },
    });
    expect(inventoryChanged).toHaveBeenCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    const issue = { code: "worker-host-unavailable", message: reason };
    expect(transport.getIssue?.("node-1")).toEqual(issue);
    const catalog = collectNodeCatalogRuntimeState(registry, connected);
    expect(catalog.issuesByNodeId.get("node-1")).toEqual([issue]);
    expect([catalog.sessionHostNodeIds.size, catalog.workerSlotsByNodeId.size]).toEqual([0, 0]);
    await expectCurrentNodes(transport);
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
      expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
        true,
        expect.objectContaining(
          method === "environments.list"
            ? { environments: expect.arrayContaining([expect.objectContaining(expected)]) }
            : expected,
        ),
      ]);
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
    expect(persistConsent.mock.calls.map(([params]) => params.sessionHost)).toEqual([false]);

    await publishInventory(registry, client, availableHost);
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(collectNodeCatalogRuntimeState(registry, connected).issuesByNodeId.size).toBe(0);
    registry.unregister("conn-1");
    expect(transport.getIssue?.("node-1")).toBeUndefined();
  });

  it("returns a retryable failure when durable consent does not commit", async () => {
    const { publish } = createCurrentRunner();
    persistConsent.mockRejectedValueOnce(new Error("database busy"));
    await publish(availableHost, RETRY_ERROR);
    await publish(availableHost);
    expect(persistConsent).toHaveBeenCalledTimes(2);
  });

  it("rejects durable consent after a same-generation connection replacement", async () => {
    const { registry, publish } = createCurrentRunner(nodeClient("conn-original"));
    const replacement = nodeClient("conn-replacement");
    persistConsent.mockImplementationOnce(async (params) => {
      register(registry, replacement);
      return params.isConnectionCurrent();
    });
    await publish(availableHost, RETRY_ERROR);
  });

  it("keeps retired v1 inventory diagnostic-only until disconnect and v6 reconnect", async () => {
    const legacyClient = nodeClient("conn-v1");
    const { registry, transport, inventoryChanged } = createCurrentRunner(legacyClient);
    await publishInventory(
      registry,
      legacyClient,
      { protocolFeatures: ["node-worker-supervisor-v1"], workerRuns: { retired: true } },
      { code: "INVALID_REQUEST", message: expect.stringContaining("openclaw update") },
    );
    expect(inventoryChanged).toHaveBeenLastCalledWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(transport.getIssue?.("node-1")).toEqual(NODE_RUNNER_UPDATE_REQUIRED_ISSUE);
    expect(persistConsent).not.toHaveBeenCalled();
    await expectCurrentNodes(transport);
    const forgedProof = {
      nodeId: "node-1",
      connId: "conn-v1",
      pairingIdentity: "identity-1",
      pairingGeneration: "generation-1",
      clientId: "node-host",
      clientMode: "node",
      protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
      workerHost: availableHost.workerHost,
      commands: ["system.run"],
    } as const;
    expect(transport.isCurrent(forgedProof)).toBe(false);
    await expect(
      transport.invoke({
        node: forgedProof,
        command: STATUS_COMMAND,
        isDispatchAuthorized: () => true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "PRIVATE_DIALECT_UNAVAILABLE" } });

    registry.unregister("conn-v1");
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(inventoryChanged).toHaveBeenCalledTimes(2);

    const currentClient = nodeClient("conn-v6");
    register(registry, currentClient);
    await publishInventory(registry, currentClient, availableHost);
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    await expectCurrentNodes(transport, {
      nodeId: "node-1",
      connId: "conn-v6",
      workerHost: availableHost.workerHost,
    });
  });

  it("rejects malformed inventory without changing private eligibility", async () => {
    const { transport, publish } = createCurrentRunner();
    await publish({ protocolFeatures: [], extra: true }, { code: "INVALID_REQUEST" });
    expect(transport.getIssue?.("node-1")).toBeUndefined();
    expect(persistConsent).not.toHaveBeenCalled();
    await expectCurrentNodes(transport);
  });

  it("rejects a stale connection without replacing the current session proof", async () => {
    const { registry, transport } = createCurrentRunner(nodeClient("conn-current"));
    const stale = nodeClient("conn-stale");
    await publishInventory(registry, stale, availableHost, { code: "INVALID_REQUEST" });
    await expectCurrentNodes(transport);
  });
});
