/**
 * Gateway node registry tests.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  buildActiveNodeContextText,
  getCurrentActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../logging/test-helpers/diagnostic-log-capture.js";
import { buildNodeInvokeRequest } from "./node-invoke-request.js";
import {
  listConnectedNodePluginTools,
  type RegisteredNodePluginToolCommand,
} from "./node-plugin-tool-snapshot.js";
import {
  collectNodeCatalogRuntimeState,
  createNodeRegistryRuntime,
  setNodeRunnerStateChangedListener,
  updateNodeRunnerInventory,
} from "./node-registry-private.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import {
  createTestNodeSocket,
  makeClient,
  registerNodeSession,
  type TestNodeSocket,
} from "./node-registry.test-helpers.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  createDeviceWorkerRuntime,
  deviceUnavailableText,
} from "./worker-environments/device-provider.js";

let testNodeHostCommands: RegisteredNodePluginToolCommand[] = [];
const activeTestRegistries = new Set<NodeRegistry>();

function createNodeRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]): NodeRegistry {
  const registry = new NodeRegistry(options);
  activeTestRegistries.add(registry);
  return registry;
}

function createPrivateRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]) {
  const runtime = createNodeRegistryRuntime(() => new NodeRegistry(options));
  activeTestRegistries.add(runtime.nodeRegistry);
  return runtime;
}

afterEach(() => {
  for (const registry of activeTestRegistries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  activeTestRegistries.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  testNodeHostCommands = [];
  setActiveNodeContexts([]);
});

function readRequest(frames: string[], index = 0) {
  const frame: { payload: ReturnType<typeof buildNodeInvokeRequest> } = JSON.parse(
    frames[index] ?? "{}",
  );
  return frame.payload;
}

function progress(registry: NodeRegistry, invokeId: string, seq: number, chunk: string) {
  return registry.handleInvokeProgress({
    invokeId,
    nodeId: "node-1",
    connId: "conn-1",
    seq,
    chunk,
  });
}

function finish(
  registry: NodeRegistry,
  id: string,
  result: Omit<Parameters<NodeRegistry["handleInvokeResult"]>[0], "id" | "nodeId" | "connId">,
) {
  return registry.handleInvokeResult({ id, nodeId: "node-1", connId: "conn-1", ...result });
}

function publishRunner(
  registry: NodeRegistry,
  workerHost: NodeWorkerHostDeclaration,
  connId = "conn-1",
) {
  return updateNodeRunnerInventory({
    registry,
    nodeId: "node-1",
    connId,
    declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost },
  });
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

const timedOut = failure("TIMEOUT", "node invoke timed out");
const aborted = failure("ABORTED", "node invoke cancelled");
const idleTimedOut = failure("IDLE_TIMEOUT", "node invoke produced no progress");
const generationTransition = {
  expectedConnId: "conn-1",
  expectedPairingIdentity: "identity-a",
  expectedPairingGeneration: "generation-a",
  nextPairingGeneration: "generation-b",
};

const pairingA = { pairingIdentity: "identity-a", pairingGeneration: "generation-a" };

function invokeFixture(params: Omit<Parameters<NodeRegistry["invoke"]>[0], "nodeId">) {
  const registry = createNodeRegistry();
  const frames = registerNode(registry);
  const invoke = registry.invoke({ nodeId: "node-1", ...params });
  const request = readRequest(frames);
  return { registry, frames, invoke, request, invokeId: request.id };
}

function registerSocket(registry: NodeRegistry, socket: TestNodeSocket, sent: string[] = []) {
  return registerNodeSession(
    registry,
    makeClient("conn-1", "node-1", sent, {
      socket: socket as unknown as GatewayWsClient["socket"],
    }),
  );
}

function registerTool(params: { name: string; command: string; description?: string }) {
  testNodeHostCommands = [
    {
      pluginId: "demo",
      command: {
        command: params.command,
        agentTool: { name: params.name, description: params.description ?? "Demo node-host tool" },
      },
    },
  ];
}

function createTestNodeRegistry(): NodeRegistry {
  return createNodeRegistry({
    listRegisteredNodePluginToolCommands: () => testNodeHostCommands,
  });
}

function makeConnectivitySocket(emitPong: boolean) {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (frame: unknown) => void;
    ping: (data?: Buffer, mask?: boolean, cb?: (err?: Error) => void) => void;
  };
  socket.readyState = 1;
  socket.send = () => {};
  socket.ping = (_dataValue, _mask, cb) => {
    cb?.();
    if (emitPong) {
      queueMicrotask(() => socket.emit("pong"));
    }
  };
  return socket as unknown as GatewayWsClient["socket"] & NonNullable<GatewayWsClient["webSocket"]>;
}

function registerNode(registry: NodeRegistry, opts: Parameters<typeof makeClient>[3] = {}) {
  const frames: string[] = [];
  registerNodeSession(registry, makeClient("conn-1", "node-1", frames, opts), {});
  return frames;
}

function registerPairingWait() {
  const pairing = createDeferred<{ identity: string; generation: string }>();
  const registry = createNodeRegistry({ resolveCurrentPairingState: () => pairing.promise });
  const frames: string[] = [];
  registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
    pairingGeneration: "generation-a",
  });
  return {
    registry,
    frames,
    release: () => pairing.resolve({ identity: "identity-a", generation: "generation-a" }),
  };
}

function startStreamingNodeInvoke(
  registry: NodeRegistry,
  options: {
    timeoutMs: number;
    idleTimeoutMs: number;
    onProgress: (chunk: string) => void;
  },
) {
  const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });
  const invoke = registry.invoke({
    nodeId: "node-1",
    command: "agent.cli.claude.run.v1",
    ...options,
  });
  const request = readRequest(frames);
  return { frames, invoke, invokeId: request.id ?? "" };
}

function expectCancellation(frames: string[], invokeId: string): void {
  const cancellations = frames
    .map((frame) => JSON.parse(frame) as { event?: string })
    .filter((frame) => frame.event === "node.invoke.cancel");
  expect(cancellations).toEqual([
    expect.objectContaining({ payload: { invokeId, nodeId: "node-1" } }),
  ]);
}

function publishTools(
  registry: NodeRegistry,
  tools: Parameters<NodeRegistry["updateNodePluginTools"]>[2],
  connId = "conn-1",
) {
  return registry.updateNodePluginTools("node-1", connId, tools);
}

function publishSkills(
  registry: NodeRegistry,
  skills: Parameters<NodeRegistry["updateNodeSkills"]>[2],
  connId = "conn-1",
) {
  return registry.updateNodeSkills("node-1", connId, skills);
}

function nodeSkill(name: string, body = "# Instructions") {
  const description = `${name} description`;
  return {
    name,
    description,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  };
}

function registerLinuxNode(registry: NodeRegistry) {
  return registerNode(registry, { clientId: "openclaw-node-host", platform: "linux" });
}

function invokeSystemRun(
  registry: NodeRegistry,
  frames: string[],
  params: Record<string, unknown>,
  timeoutMs = 1_000,
) {
  const invoke = registry.invoke({ nodeId: "node-1", command: "system.run", params, timeoutMs });
  const request = readRequest(frames);
  return { invoke, request };
}

type SystemRunEvent = Parameters<NodeRegistry["authorizeSystemRunEvent"]>[0];

function authorizeRun(registry: NodeRegistry, overrides: Partial<SystemRunEvent> = {}) {
  return registry.authorizeSystemRunEvent({
    nodeId: "node-1",
    connId: "conn-1",
    sessionKey: "agent:main:main",
    terminal: true,
    ...overrides,
  });
}

function computerUseDescriptor() {
  return {
    contractVersion: 2 as const,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions: ["screenshot", "left_click"] as const,
    targets: ["screen"] as const,
    deliveryModes: ["foreground"] as const,
    observations: ["image"] as const,
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
}

describe("gateway/node-registry", () => {
  it("rejects registration without an authenticated pairing identity", () => {
    const registry = createNodeRegistry();
    const client = makeClient("conn-unbound", "node-unbound");

    expect(() => registry.register(client, {} as never)).toThrow(
      "node session registration requires pairing identity",
    );
    expect(registry.listConnected()).toEqual([]);
  });

  it("rejects dispatch through an invalidated node connection", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    const socket = makeConnectivitySocket(true);
    const ping = vi.spyOn(socket, "ping");
    const client = makeClient("conn-invalidated", "node-invalidated", frames, {
      socket,
      webSocket: socket,
      commands: ["demo.echo"],
    });
    registerNodeSession(registry, client, {});
    registry.updateNodePluginTools("node-invalidated", "conn-invalidated", [
      { pluginId: "demo", name: "demo_echo", description: "Echo", command: "demo.echo" },
    ]);
    expect(listConnectedNodePluginTools()).toHaveLength(1);
    expect(
      registry.invalidateConnectionForPairingChange("conn-invalidated", "device-token-revoked"),
    ).toBe(true);
    expect(client.invalidatedReason).toBe("device-token-revoked");
    expect(listConnectedNodePluginTools()).toEqual([]);

    expect(registry.get("node-invalidated")).toBeUndefined();
    expect(registry.listConnected()).toEqual([]);
    expect(registry.sendEvent("node-invalidated", "node.test", { ok: true })).toBe(false);
    await expect(
      registry.invoke({ nodeId: "node-invalidated", command: "system.run" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PAIRING_CHANGED" },
    });
    expect(frames).toEqual([]);
    await expect(registry.checkConnectivity("node-invalidated", 50)).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_CONNECTED" },
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it("rejects a private worker command through the generic invoke surface", async () => {
    const registry = createNodeRegistry();
    const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });

    await expect(
      registry.invoke({ nodeId: "node-1", command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND }),
    ).resolves.toEqual(failure("INVALID_REQUEST", "private node command is not invocable"));
    expect(frames).toEqual([]);
    expect(Reflect.ownKeys(registry)).not.toContain("invokeCore");
    expect(Reflect.ownKeys(Object.getPrototypeOf(registry))).not.toContain("invokeCore");
  });

  it("binds the private dialect to the exact connection generation", async () => {
    const clientId = GATEWAY_CLIENT_IDS.MACOS_APP;
    let currentGeneration = "generation-a";
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createPrivateRegistry({
        resolveCurrentPairingState: async () => ({
          identity: "identity-a",
          generation: currentGeneration,
        }),
      });
    const readNodes = async () => {
      const node = await transport.getCurrentNode("node-1");
      return node ? [node] : [];
    };
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { clientId, commands: ["system.run"] }),
      pairingA,
    );

    await expect(readNodes()).resolves.toEqual([]);
    expect(
      publishRunner(registry, { enabled: true, capacity: { total: 2, available: 2 } }),
    ).toEqual({ changed: true });
    await expect(readNodes()).resolves.toEqual([
      expect.objectContaining({
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "identity-a",
        pairingGeneration: "generation-a",
        clientId,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        commands: ["system.run"],
      }),
    ]);
    expect(registry.get("node-1")).not.toHaveProperty("protocolFeatures");
    expect(
      collectNodeCatalogRuntimeState(registry, [
        { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-a" },
      ]).sessionHostNodeIds.has("node-1"),
    ).toBe(true);

    currentGeneration = "generation-b";
    expect(
      registry.updateSurface("node-1", { commands: ["system.run"] }, generationTransition),
    ).not.toBeNull();
    await expect(readNodes()).resolves.toEqual([]);
    expect(
      collectNodeCatalogRuntimeState(registry, [
        { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-b" },
      ]).sessionHostNodeIds.has("node-1"),
    ).toBe(false);
    expect(
      publishRunner(registry, { enabled: true, capacity: { total: 2, available: 2 } }),
    ).toEqual({ changed: true });
    await expect(readNodes()).resolves.toEqual([
      expect.objectContaining({ pairingGeneration: "generation-b" }),
    ]);

    registerNodeSession(
      registry,
      makeClient("conn-2", "node-1", [], { clientId, commands: ["system.run"] }),
      { pairingIdentity: "identity-a", pairingGeneration: "generation-b" },
    );
    await expect(readNodes()).resolves.toEqual([]);
    expect(
      publishRunner(registry, { enabled: true, capacity: { total: 2, available: 2 } }),
    ).toBeNull();
    expect(
      publishRunner(registry, { enabled: true, capacity: { total: 2, available: 2 } }, "conn-2"),
    ).toEqual({ changed: true });
    await expect(readNodes()).resolves.toEqual([
      expect.objectContaining({
        connId: "conn-2",
        pairingGeneration: "generation-b",
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      }),
    ]);
  });

  it("reports connected nodes without session hosting as ineligible, not disconnected", async () => {
    const resolveCurrentPairingState = vi.fn(async () => ({
      identity: "identity-a",
      generation: "generation-a",
    }));
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createPrivateRegistry({
        resolveCurrentPairingState,
      });
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      pairingA,
    );
    registerNodeSession(registry, makeClient("conn-unrelated", "node-unrelated"), pairingA);
    const runtime = createDeviceWorkerRuntime({
      getPairedDevice: async () => ({
        deviceId: "node-1",
        publicKey: "fixture",
        role: "node",
        roles: ["node"],
        tokens: { node: { token: "fixture-token", role: "node", scopes: [], createdAtMs: 1 } },
        createdAtMs: 1,
        approvedAtMs: 1,
      }),
    });
    runtime.bindNodeTransport(transport);
    const availability = await runtime.resolveAvailability("node-1");
    expect(registry.get("node-1")).toBeDefined();
    expect(availability).toMatchObject({
      available: false,
      unavailableReason: "hosting-unavailable",
    });
    expect(deviceUnavailableText("node-1", availability)).toContain("enable session hosting");
    expect(resolveCurrentPairingState).toHaveBeenCalledExactlyOnceWith("node-1");
  });

  it("separates inventory topology from availability across proof mutations", async () => {
    const runnerStateChanged = vi.fn();
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createPrivateRegistry();
    setNodeRunnerStateChangedListener(registry, runnerStateChanged);
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        commands: ["system.run"],
      }),
      pairingA,
    );
    const publish = (workerHost: NodeWorkerHostDeclaration) =>
      updateNodeRunnerInventory({
        registry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost },
      });
    const retained = {
      enabled: true as const,
      capacity: { total: 2, available: 2 },
      bundleRetention: 1 as const,
      bundleStatus: 1 as const,
    };

    expect(publish(retained)).toEqual({ changed: true });
    const priorProof = expectDefined((await transport.listCurrentNodes())[0], "runner proof");
    expect(publish({ ...retained, bundlePrewarm: 1 })).toEqual({ changed: true });
    expect((await transport.listCurrentNodes())[0]?.workerHost.bundlePrewarm).toBe(1);
    expect(transport.isCurrent(priorProof, true, ["system.run"])).toBe(true);
    registry.updateSurface("node-1", { commands: [] });
    expect(transport.isCurrent(priorProof, true)).toBe(true);
    expect(transport.isCurrent(priorProof, true, ["system.run"])).toBe(false);
    registry.updateSurface("node-1", { commands: ["system.run"] });
    runnerStateChanged.mockClear();
    expect(publish({ ...retained, capacity: { total: 2, available: 0 } })).toEqual({
      changed: true,
    });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(transport.hasCurrentRunner("node-1")).toBe(true);

    runnerStateChanged.mockClear();
    expect(publish({ ...retained, capacity: { total: 2, available: 0 } })).toEqual({
      changed: false,
    });
    expect(runnerStateChanged).not.toHaveBeenCalled();

    expect(publish({ ...retained, capacity: { total: 2, available: 0 }, statusWait: 1 })).toEqual({
      changed: true,
    });
    expect(publish({ ...retained, statusWait: 1, capacity: { available: 0, total: 2 } })).toEqual({
      changed: false,
    });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    runnerStateChanged.mockClear();

    const [proof] = await transport.listCurrentNodes();
    if (!proof) {
      throw new Error("expected current runner proof");
    }
    expect(transport.isCurrent(proof, true)).toBe(false);
    const idleHost = {
      ...retained,
      idleRetention: true as const,
      capacity: { total: 2, available: 0, reclaimableIdle: 1 },
    };
    expect(publish(idleHost)).toEqual({ changed: true });
    expect(transport.isCurrent(proof, true)).toBe(true);
    expect(
      collectNodeCatalogRuntimeState(registry, [
        { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-a" },
      ]).workerSlotsByNodeId.get("node-1"),
    ).toEqual(idleHost.capacity);
    expect(
      publish({ ...idleHost, capacity: { ...idleHost.capacity, reclaimableIdle: 0 } }),
    ).toEqual({ changed: true });
    expect(transport.isCurrent(proof, true)).toBe(false);
    runnerStateChanged.mockClear();
    expect(
      transport.acceptBundleStatus?.(proof, {
        bundleHash: "a".repeat(64),
        status: { status: "missing" },
      }),
    ).toBe(true);
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });

    runnerStateChanged.mockClear();
    expect(
      registry.updateSurface("node-1", { commands: ["system.run"] }, generationTransition),
    ).not.toBeNull();
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    expect(publish(retained)).toEqual({ changed: true });
    runnerStateChanged.mockClear();
    expect(publishRunner(registry, { enabled: false })).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: true,
    });

    runnerStateChanged.mockClear();
    expect(
      updateNodeRunnerInventory({
        registry,
        nodeId: "node-1",
        connId: "conn-1",
        declaration: { protocolFeatures: [] },
      }),
    ).toEqual({ changed: true });
    expect(runnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-1", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
  });

  it.each([GATEWAY_CLIENT_IDS.NODE_HOST])(
    "keeps capacity admission separate from negotiated environment turn reuse (%s)",
    async (clientId) => {
      const frames: string[] = [];
      const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
        createPrivateRegistry();
      registerNodeSession(
        registry,
        makeClient("conn-1", "node-1", frames, { clientId, commands: ["system.run"] }),
        pairingA,
      );
      expect(
        publishRunner(registry, { enabled: true, capacity: { total: 2, available: 2 } }),
      ).toEqual({ changed: true });
      const [candidate] = await transport.listCurrentNodes();
      const proof = expectDefined(candidate, "current supervisor proof");
      expect(proof.clientId).toBe(clientId);
      expect(
        publishRunner(registry, { enabled: true, capacity: { total: 2, available: 0 } }),
      ).toEqual({ changed: true });
      expect(
        collectNodeCatalogRuntimeState(registry, [
          { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-a" },
        ]).sessionHostNodeIds.has("node-1"),
      ).toBe(true);

      // Catalog host consent uses the supplied generation; capacity still describes
      // the current connection, including a full host with zero available slots.
      const snapshot = collectNodeCatalogRuntimeState(registry, [
        { nodeId: "node-1", connId: "conn-1", pairingGeneration: "stale-generation" },
      ]);
      expect(snapshot.sessionHostNodeIds.has("node-1")).toBe(false);
      expect(snapshot.workerSlotsByNodeId.get("node-1")).toEqual({ total: 2, available: 0 });
      const projectedCapacity = snapshot.workerSlotsByNodeId.get("node-1");
      if (!projectedCapacity) {
        throw new Error("expected projected capacity");
      }
      // JavaScript consumers can mutate a readonly-typed snapshot without changing admission.
      Object.assign(projectedCapacity, { available: 2 });
      expect(transport.isCurrent(proof, true)).toBe(false);
      expect(frames).toEqual([]);

      const workspaceInvoke = transport.invoke({
        node: proof,
        command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
        isDispatchAuthorized: () => true,
      });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      const request = readRequest(frames);
      expect(
        registry.handleInvokeResult({
          id: request.id ?? "",
          nodeId: "node-1",
          connId: "conn-1",
          ok: true,
          payloadJSON: "null",
        }),
      ).toBe(true);
      await expect(workspaceInvoke).resolves.toMatchObject({ ok: true, payloadJSON: "null" });

      await expect(
        transport.invoke({
          node: proof,
          command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
          isDispatchAuthorized: () => true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "PRIVATE_DIALECT_UNAVAILABLE" },
      });

      publishRunner(registry, {
        enabled: true,
        capacity: { total: 2, available: 0 },
        environmentSession: 1,
        capturedExecPolicy: true,
        promptContext: 1,
      });
      expect(transport.isCurrent(proof, true)).toBe(false);
      for (const command of [
        NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
      ] as const) {
        const invocation = transport.invoke({
          node: proof,
          command,
          isDispatchAuthorized: () => true,
        });
        await vi.waitFor(() => expect(frames.at(-1)).toContain(command));
        const dispatched = JSON.parse(frames.at(-1) ?? "{}") as { payload: { id: string } };
        registry.handleInvokeResult({
          id: dispatched.payload.id,
          nodeId: "node-1",
          connId: "conn-1",
          ok: true,
          payloadJSON: "null",
        });
        await expect(invocation).resolves.toMatchObject({ ok: true });
      }
      expect(publishRunner(registry, { enabled: false })).toEqual({ changed: true });
      const sentCount = frames.length;
      await expect(
        transport.invoke({
          node: proof,
          command: NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
          isDispatchAuthorized: () => true,
        }),
      ).resolves.toEqual(
        failure("PRIVATE_DIALECT_UNAVAILABLE", "node worker supervisor dialect is unavailable"),
      );
      expect(frames).toHaveLength(sentCount);
    },
  );

  it.each([
    {
      closed: "generation",
      command: "system.run",
      code: "PAIRING_CHANGED",
      message: "node pairing changed before dispatch",
    },
    {
      closed: "authority",
      command: "system.run",
      code: "APPROVAL_AUTHORITY_CLOSED",
      message: "runtime authority closed before node dispatch",
    },
    {
      closed: "store",
      command: "system.which",
      code: "UNAVAILABLE",
      message: "node pairing state unavailable before dispatch",
    },
  ])(
    "rejects dispatch when pairing resolution closes $closed",
    async ({ closed, command, code, message }) => {
      const pairing = createDeferred<{ identity: string; generation: string }>();
      const resolveCurrentPairingState = vi.fn(() => pairing.promise);
      const registry = createNodeRegistry({ resolveCurrentPairingState });
      const frames: string[] = [];
      registerNodeSession(registry, makeClient("conn-1", "node-1", frames), pairingA);
      let authorityActive = true;
      const isDispatchAuthorized = vi.fn(() => authorityActive);
      const onDispatchReady = vi.fn();
      const invoke = registry.invoke({
        nodeId: "node-1",
        expectedConnId: "conn-1",
        expectedPairingGeneration: "generation-a",
        command,
        isDispatchAuthorized,
        onDispatchReady,
      });
      if (closed === "store") {
        pairing.reject(new Error("pairing store unavailable"));
      } else {
        authorityActive = closed !== "authority";
        pairing.resolve({
          identity: "identity-a",
          generation: closed === "generation" ? "generation-b" : "generation-a",
        });
      }
      await expect(invoke).resolves.toEqual(failure(code, message));
      expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-1");
      expect(frames).toEqual([]);
      expect(onDispatchReady).not.toHaveBeenCalled();
      if (closed === "store") {
        await expect(registry.getCurrentConnected("node-1")).resolves.toBeUndefined();
        expect(registry.listConnected()).toHaveLength(1);
        expect(isDispatchAuthorized).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["prompt-context", "authority"] as const)(
    "rechecks %s after the private launch pairing await",
    async (closed) => {
      const pairing = createDeferred<{ identity: string; generation: string }>();
      const currentPairing = { identity: "identity-a", generation: "generation-a" };
      const resolveCurrentPairingState = vi.fn().mockResolvedValue(currentPairing);
      const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
        createPrivateRegistry({ resolveCurrentPairingState });
      const frames: string[] = [];
      registerNodeSession(
        registry,
        makeClient("conn-1", "node-1", frames, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST }),
        pairingA,
      );
      const workerHost = {
        enabled: true as const,
        capacity: { total: 1, available: 1 },
        environmentSession: 1 as const,
        capturedExecPolicy: true as const,
        promptContext: 1 as const,
      };
      publishRunner(registry, workerHost);
      const proof = expectDefined((await transport.listCurrentNodes())[0], "runner proof");
      resolveCurrentPairingState.mockImplementationOnce(() => pairing.promise);
      let authorized = true;
      const dispatched = vi.fn();
      const outcome = transport.invoke({
        node: proof,
        command: NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
        params: {},
        isDispatchAuthorized: () => authorized,
        onDispatchReady: dispatched,
      });
      if (closed === "prompt-context") {
        publishRunner(registry, { ...workerHost, promptContext: undefined });
      } else {
        authorized = false;
      }
      pairing.resolve(currentPairing);
      await expect(outcome).resolves.toMatchObject({ ok: false });
      expect(frames).toEqual([]);
      expect(dispatched).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: "result", authority: "false" },
    { operation: "result", authority: "throws" },
    { operation: "progress", authority: "false" },
    { operation: "input", authority: "false" },
    { operation: "continuation", authority: "false" },
    { operation: "current", authority: "false" },
  ] as const)(
    "settles closed completion authority through $operation ($authority)",
    async ({ operation, authority }) => {
      vi.useFakeTimers();
      const registry = createNodeRegistry();
      const frames = registerNode(registry, { clientId: GATEWAY_CLIENT_IDS.NODE_HOST });
      const onProgress = vi.fn();
      const continuation = vi.fn(async () => true);
      let authorityActive = true;
      const invoke = registry.invokeLifecycle({
        nodeId: "node-1",
        command: "agent.cli.claude.run.v1",
        timeoutMs: 1_000,
        onProgress,
        isDispatchAuthorized: () => {
          if (!authorityActive && authority === "throws") {
            throw new Error("completion owner is unavailable");
          }
          return authorityActive;
        },
      });
      const invokeId = readRequest(frames).id;
      let result: Awaited<typeof invoke> | undefined;
      void invoke.then((value) => {
        result = value;
      });
      try {
        authorityActive = false;
        const identity = { invokeId, nodeId: "node-1", connId: "conn-1" };
        if (operation === "result") {
          expect(
            registry.handleInvokeResult({
              id: invokeId,
              nodeId: identity.nodeId,
              connId: identity.connId,
              ok: true,
              payload: { answer: "must not reach a closed owner" },
            }),
          ).toBe(false);
        } else if (operation === "progress") {
          expect(registry.handleInvokeProgress({ ...identity, seq: 0, chunk: "withheld" })).toBe(
            false,
          );
        } else if (operation === "input") {
          expect(() => registry.sendInvokeInput(invokeId, { input: "withheld" })).toThrow(
            "node invoke is not pending",
          );
        } else if (operation === "continuation") {
          expect(
            registry.runPendingInvokeContinuation({ ...identity, run: continuation }),
          ).toBeNull();
        } else {
          expect(registry.isInvokeCurrent(invokeId, identity.nodeId, identity.connId)).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(result).toEqual({
          ok: false,
          error: {
            code: "APPROVAL_AUTHORITY_CLOSED",
            message: "node invoke authority closed before settlement",
          },
        });
        expectCancellation(frames, invokeId);
        expect(frames).toHaveLength(2);
        expect(onProgress).not.toHaveBeenCalled();
        expect(continuation).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        authorityActive = true;
        expect(registry.isInvokeCurrent(invokeId, identity.nodeId, identity.connId)).toBe(false);
      } finally {
        registry.unregister("conn-1");
        await invoke;
        vi.useRealTimers();
      }
    },
  );

  it.each(["inbound RPC", "connected lookup", "prompt projection", "unavailable publication"])(
    "revalidates persistent pairing authority for %s",
    async (boundary) => {
      let generation = "generation-a";
      const resolveCurrentPairingState = vi.fn(async () => ({
        identity: "identity-a",
        generation,
      }));
      const onPairingInvalidated = vi.fn();
      const usesPublication =
        boundary === "prompt projection" || boundary === "unavailable publication";
      const registry = createNodeRegistry({
        resolveCurrentPairingState: usesPublication ? undefined : resolveCurrentPairingState,
        isPairingStateCurrent: usesPublication
          ? (_nodeId, expected) => {
              if (boundary === "unavailable publication") {
                throw new Error("pairing store unavailable");
              }
              return expected.identity === "identity-a" && expected.generation === generation;
            }
          : undefined,
        onPairingInvalidated,
      });
      const client = makeClient("conn-generation", "node-generation", [], {
        permissions: { accessibility: true },
      });
      registerNodeSession(registry, client, pairingA);
      if (boundary === "inbound RPC") {
        await expect(registry.isConnectionCurrentPairingState("conn-generation")).resolves.toBe(
          true,
        );
      } else if (boundary !== "unavailable publication") {
        registry.updatePresenceActivity({
          nodeId: "node-generation",
          connId: "conn-generation",
          idleSeconds: 0,
        });
        expect(registry.getActiveNode()?.nodeId).toBe("node-generation");
        expect(getCurrentActiveNodeContext()).toMatchObject({
          nodeId: "node-generation",
          pairingGeneration: "generation-a",
        });
        if (usesPublication) {
          expect(registry.listCurrentConnectedSync()).toHaveLength(1);
        }
      }

      generation = "generation-b";
      if (boundary === "inbound RPC") {
        await expect(registry.isConnectionCurrentPairingState("conn-generation")).resolves.toBe(
          false,
        );
        expect(client.invalidated).toBe(true);
        expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-generation");
      } else if (boundary === "connected lookup") {
        await expect(registry.getCurrentConnected("node-generation")).resolves.toBeUndefined();
        expect(registry.getActiveNode()).toBeUndefined();
        expect(getCurrentActiveNodeContext()).toBeNull();
        expect(client.invalidated).toBe(true);
        expect(onPairingInvalidated).toHaveBeenCalledWith({
          nodeId: "node-generation",
          connId: "conn-generation",
        });
      } else {
        expect(getCurrentActiveNodeContext()).toBeNull();
        expect(registry.listCurrentConnectedSync()).toEqual([]);
        if (boundary === "unavailable publication") {
          expect(client.invalidated).not.toBe(true);
          expect(registry.listConnected()).toHaveLength(1);
        } else {
          expect(registry.listConnected()).toEqual([]);
        }
      }
    },
  );

  it("does not invalidate a session promoted while persistent generation is loading", async () => {
    const lookup = createDeferred<{ identity: string; generation: string }>();
    const resolveCurrentPairingState = vi.fn(() => lookup.promise);
    const onPairingInvalidated = vi.fn();
    const registry = createNodeRegistry({ resolveCurrentPairingState, onPairingInvalidated });
    const client = makeClient("conn-1", "node-1");
    registerNodeSession(registry, client, pairingA);
    const connected = registry.getCurrentConnected("node-1");
    expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-1");
    expect(registry.updateSurface("node-1", { commands: [] }, generationTransition)).not.toBeNull();
    lookup.resolve({ identity: "identity-a", generation: "generation-a" });

    await expect(connected).resolves.toBeUndefined();
    expect(registry.get("node-1")?.pairingGeneration).toBe("generation-b");
    expect(client.invalidated).not.toBe(true);
    expect(onPairingInvalidated).not.toHaveBeenCalled();
  });

  it("routes ordered input to the pending invoke connection and rejects unknown invokes", async () => {
    const registry = createNodeRegistry();
    const frames: string[] = [];
    const socket = createTestNodeSocket(frames);
    registerSocket(registry, socket, frames);
    const controller = new AbortController();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "codex.terminal.resume.v1",
      sessionKey: "agent:main:canvas",
      timeoutMs: 0,
      signal: controller.signal,
      onProgress: () => {},
    });
    const request = readRequest(frames);
    const invokeId = request.id ?? "";

    expect(readRequest(frames).sessionKey).toBe("agent:main:canvas");
    expect(() => registry.sendInvokeInput(invokeId, undefined)).toThrow("not serializable");
    expect(() =>
      registry.sendInvokeInput(invokeId, { kind: "data", data: "x".repeat(17 * 1024) }),
    ).toThrow("exceeds 16 KiB");
    socket.readyState = WebSocket.CLOSING;
    expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "lost" })).toThrow(
      "failed to send node invoke input",
    );
    expect(frames).toHaveLength(1);
    socket.readyState = WebSocket.OPEN;
    registry.sendInvokeInput(invokeId, { kind: "data", data: "a" });
    registry.sendInvokeInput(invokeId, { kind: "resize", cols: 90, rows: 30 });
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: {
        id: invokeId,
        nodeId: "node-1",
        seq: 0,
        payloadJSON: JSON.stringify({ kind: "data", data: "a" }),
      },
    });
    expect(JSON.parse(frames[2] ?? "{}")).toMatchObject({
      event: "node.invoke.input",
      payload: { id: invokeId, nodeId: "node-1", seq: 1 },
    });
    expect(() => registry.sendInvokeInput("missing", { kind: "data", data: "x" })).toThrow(
      "node invoke is not pending",
    );

    controller.abort();
    await expect(invoke).resolves.toMatchObject({ ok: false, error: { code: "ABORTED" } });
  });

  it.each(["websocket", "polling"])(
    "rejects a replaced %s connectivity probe",
    async (transport) => {
      const registry = createTestNodeRegistry();
      const oldSocket = makeConnectivitySocket(false);
      const probe = createDeferred<{ ok: true }>();
      const client = makeClient("conn-old", "node-1", [], {
        socket: oldSocket,
        webSocket: oldSocket,
      });
      if (transport === "websocket") {
        registerNodeSession(registry, client);
      } else {
        registry.registerTransport(
          client,
          { pairingIdentity: "identity-a" },
          {
            send: () => true,
            sendRaw: () => true,
            checkConnectivity: () => probe.promise,
          },
        );
      }

      const connectivity = registry.checkConnectivity("node-1", 50);
      const invoke = registry.invoke({ nodeId: "node-1", command: "debug.ping", timeoutMs: 0 });
      const newSocket = makeConnectivitySocket(true);
      const replacement = registerNodeSession(
        registry,
        makeClient("conn-new", "node-1", [], { socket: newSocket, webSocket: newSocket }),
        {},
      );
      if (transport === "websocket") {
        (oldSocket as unknown as EventEmitter).emit("pong");
      } else {
        probe.resolve({ ok: true });
      }

      await expect(connectivity).resolves.toEqual(
        failure("NOT_CONNECTED", "node connection changed during connectivity check"),
      );
      await expect(invoke).resolves.toEqual(
        failure("DISCONNECTED", "node disconnected (debug.ping)"),
      );
      expect(registry.unregister("conn-old")).toBeNull();
      expect(registry.get("node-1")).toBe(replacement);
      const sent = vi.spyOn(newSocket, "send");
      const onDispatchReady = vi.fn();
      await expect(
        registry.invoke({
          nodeId: "node-1",
          expectedConnId: "conn-old",
          command: "system.run",
          onDispatchReady,
        }),
      ).resolves.toEqual(failure("ROUTE_CHANGED", "node connection changed before dispatch"));
      expect(sent).not.toHaveBeenCalled();
      expect(onDispatchReady).not.toHaveBeenCalled();
      await expect(registry.checkConnectivity("node-1", 50)).resolves.toEqual({ ok: true });
    },
  );

  it("reports stale node websocket connectivity before invoke timeout", async () => {
    const registry = createTestNodeRegistry();
    const socket = makeConnectivitySocket(false);
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { socket, webSocket: socket }),
      {},
    );

    const result = await registry.checkConnectivity("node-1", 1);

    expect(result).toEqual(failure("TIMEOUT", "node connectivity check timed out"));
  });

  it("settles zero-timeout MCP calls without disconnecting the replacement node", async () => {
    const registry = createNodeRegistry();
    registerNodeSession(registry, makeClient("conn-old", "node-1"));
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "mcp.tools.call.v1",
      timeoutMs: 0,
    });

    const replacement = registerNodeSession(registry, makeClient("conn-new", "node-1"));

    await expect(invoke).resolves.toEqual(
      failure("MCP_SERVER_UNAVAILABLE", "node host disconnected during MCP tool call"),
    );
    expect(registry.get("node-1")).toBe(replacement);
    expect(registry.unregister("conn-old")).toBeNull();
    expect(registry.get("node-1")).toBe(replacement);
  });

  it.each([true, false])("settles system.run event authority after ok=%s", async (ok) => {
    const registry = createTestNodeRegistry();
    const frames = ok ? registerLinuxNode(registry) : registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, {
      runId: "run-1",
      sessionKey: "agent:main:main",
      ...(!ok ? { timeoutMs: 0 } : {}),
    });
    if (ok) {
      expect(authorizeRun(registry)).toBe(false);
      expect(authorizeRun(registry, { runId: "run-1", terminal: false })).toBe(true);
      expect(
        authorizeRun(registry, { connId: "conn-other", runId: "run-1", terminal: false }),
      ).toBe(false);
      expect(authorizeRun(registry, { runId: "run-other", terminal: false })).toBe(false);
    }
    const error = ok ? null : { code: "INVALID_REQUEST", message: "invalid params" };
    expect(finish(registry, request.id, { ok, ...(error ? { error } : {}) })).toBe(true);
    await expect(invoke).resolves.toEqual({ ok, payload: undefined, payloadJSON: null, error });
    expect(authorizeRun(registry, { runId: "run-1", terminal: true })).toBe(ok);
    expect(authorizeRun(registry, { runId: "run-1", terminal: false })).toBe(false);
  });

  it.each([
    { runTimeout: 0, invokeTimeout: 1, forwardedTimeout: null, expires: false },
    {
      runTimeout: Number.MAX_SAFE_INTEGER,
      invokeTimeout: Number.MAX_SAFE_INTEGER,
      forwardedTimeout: MAX_TIMER_TIMEOUT_MS,
      expires: true,
    },
  ])(
    "bounds system.run authorization for timeout=$runTimeout",
    async ({ runTimeout, invokeTimeout, forwardedTimeout, expires }) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const registry = createTestNodeRegistry();
      const frames = registerNode(registry);
      const { invoke, request } = invokeSystemRun(
        registry,
        frames,
        { runId: "run-timeout", sessionKey: "agent:main:main", timeoutMs: runTimeout },
        invokeTimeout,
      );
      const forwarded = JSON.parse(request.paramsJSON ?? "{}") as { timeoutMs?: number | null };

      expect(forwarded.timeoutMs).toBe(forwardedTimeout);
      expect(request.timeoutMs).toBe(expires ? MAX_TIMER_TIMEOUT_MS : 1);
      await vi.advanceTimersByTimeAsync(expires ? MAX_TIMER_TIMEOUT_MS : 1);
      await expect(invoke).resolves.toEqual(timedOut);
      expectCancellation(frames, request.id);
      if (!expires) {
        await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      }
      expect(authorizeRun(registry, { runId: "run-timeout" })).toBe(!expires);
    },
  );

  it("shares the invoke budget across pairing, serialization, and the pending response", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { registry, frames, release } = registerPairingWait();
    const onDispatchReady = vi.fn();
    const runParams = { runId: "run-budget", timeoutMs: 5_000 };
    try {
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        timeoutMs: 100,
        params: {
          ...runParams,
          toJSON() {
            now += 10.5;
            return runParams;
          },
        },
        onDispatchReady,
      });
      await vi.advanceTimersByTimeAsync(60);
      now = 1_060;
      release();
      await vi.advanceTimersByTimeAsync(0);
      const request = readRequest(frames);
      expect(request.timeoutMs).toBe(30);
      expect(JSON.parse(expectDefined(request.paramsJSON, "system.run parameters")).timeoutMs).toBe(
        5_000,
      );
      expect(onDispatchReady).toHaveBeenCalledExactlyOnceWith(request.id, 1_100);
      now = 1_100;
      await vi.advanceTimersByTimeAsync(30);
      await expect(invoke).resolves.toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
      expect(finish(registry, request.id, { ok: true })).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      registry.unregister("conn-1");

      vi.useRealTimers();
    }
  });

  it("bounds stalled pairing by an inherited positive fractional budget", async () => {
    vi.useFakeTimers();
    let now = 1_099.5;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { registry, frames, release } = registerPairingWait();
    const invoke = registry.invoke({
      nodeId: "node-1",
      command: "demo.echo",
      timeoutMs: 0.5,
      deadlineAtMs: 1_100,
    });
    let result: Awaited<typeof invoke> | undefined;
    void invoke.then((value) => {
      result = value;
    });
    try {
      now = 1_100;
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
      expect(frames).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      registry.unregister("conn-1");
      await invoke;

      vi.useRealTimers();
    }
  });

  it("keeps a fractional deadline open when the hard timer fires early", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { registry, request, invoke } = invokeFixture({
      command: "debug.ping",
      timeoutMs: 101,
      params: {
        toJSON() {
          now += 0.5;
          return {};
        },
      },
    });
    let result: Awaited<typeof invoke> | undefined;
    void invoke.then((value) => {
      result = value;
    });
    try {
      expect(request.timeoutMs).toBe(101);
      // Deliver the timer callback while the elapsed clock is still before expiry.
      now = 1_100.75;
      await vi.advanceTimersByTimeAsync(101);
      expect(result).toBeUndefined();
      expect(finish(registry, request.id, { ok: true, payload: { value: "in time" } })).toBe(true);
      await expect(invoke).resolves.toMatchObject({ ok: true, payload: { value: "in time" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      registry.unregister("conn-1");
      await invoke;

      vi.useRealTimers();
    }
  });

  it.each(["deadline", "authority", "abort"])(
    "does not dispatch when serialization closes the %s",
    async (closed) => {
      vi.useFakeTimers();
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const registry = createNodeRegistry();
      const frames = registerNode(registry);
      const controller = new AbortController();
      let authorityActive = true;
      const onDispatchReady = vi.fn();
      let invoke: ReturnType<NodeRegistry["invoke"]> | undefined;
      try {
        invoke = registry.invoke({
          nodeId: "node-1",
          command: "browser.proxy",
          timeoutMs: 100,
          signal: controller.signal,
          isDispatchAuthorized: () => authorityActive,
          onDispatchReady,
          params: {
            toJSON() {
              if (closed === "deadline") {
                now += 100;
              }
              if (closed === "authority") {
                authorityActive = false;
              }
              if (closed === "abort") {
                controller.abort();
              }
              return {};
            },
          },
        });
        let result: Awaited<typeof invoke> | undefined;
        void invoke.then((value) => {
          result = value;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(result).toMatchObject({
          ok: false,
          error: {
            code:
              closed === "deadline"
                ? "TIMEOUT"
                : closed === "authority"
                  ? "APPROVAL_AUTHORITY_CLOSED"
                  : "ABORTED",
          },
        });
        expect(frames).toEqual([]);
        expect(onDispatchReady).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.abort();
        registry.unregister("conn-1");
        await invoke;

        vi.useRealTimers();
      }
    },
  );

  it.each([undefined, 0.5])(
    "preserves the post-pairing timeout contract for %s",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const { registry, frames, release } = registerPairingWait();
      try {
        const invoke = registry.invoke({ nodeId: "node-1", command: "demo.echo", timeoutMs });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(frames).toEqual([]);
        release();
        await vi.advanceTimersByTimeAsync(0);
        const request = readRequest(frames);
        const fallback = timeoutMs === undefined || !Number.isFinite(timeoutMs);
        expect(request.timeoutMs).toBe(fallback ? 30_000 : 0);
        if (!fallback) {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        expect(finish(registry, request.id, { ok: true })).toBe(true);
        await expect(invoke).resolves.toMatchObject({ ok: true });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release();
        vi.useRealTimers();
      }
    },
  );

  it.each(["disconnect", "abort"])(
    "prefers an elapsed hard deadline when %s beats the timer callback",
    async (termination) => {
      vi.useFakeTimers();
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const registry = createNodeRegistry();
      registerNode(registry);

      if (termination === "abort") {
        const beforeDeadlineController = new AbortController();
        const beforeDeadline = registry.invoke({
          nodeId: "node-1",
          command: "debug.ping",
          timeoutMs: 100,
          signal: beforeDeadlineController.signal,
        });
        now = 1_099;
        beforeDeadlineController.abort();
        await expect(beforeDeadline).resolves.toEqual(aborted);
      }

      now = 2_000;
      const atDeadlineController = new AbortController();
      const atDeadline = registry.invoke({
        nodeId: "node-1",
        command: "debug.ping",
        timeoutMs: 100,
        signal: atDeadlineController.signal,
      });
      now = 2_100;
      if (termination === "abort") {
        atDeadlineController.abort();
      } else {
        expect(registry.unregister("conn-1")).toBe("node-1");
      }
      await expect(atDeadline).resolves.toEqual(timedOut);
    },
  );

  it("rejects streamed input at the hard deadline before its timer callback runs", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const registry = createNodeRegistry();
    const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
      timeoutMs: 100,
      idleTimeoutMs: 1_000,
      onProgress: () => {},
    });

    now = 1_099;
    registry.sendInvokeInput(invokeId, { kind: "data", data: "before" });

    now = 1_100;
    expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "expired" })).toThrow(
      "node invoke is not pending",
    );
    await expect(invoke).resolves.toEqual(timedOut);
    const inputFrames = frames
      .map((frame) => JSON.parse(frame) as { event?: string; payload?: { payloadJSON?: string } })
      .filter((frame) => frame.event === "node.invoke.input");
    expect(inputFrames).toHaveLength(1);
    expect(inputFrames[0]?.payload?.payloadJSON).toBe(
      JSON.stringify({ kind: "data", data: "before" }),
    );
    expectCancellation(frames, invokeId);
    await vi.runOnlyPendingTimersAsync();
    expectCancellation(frames, invokeId);
  });

  it.each(["deadline", "abort", "consumer failure"])(
    "stops buffered progress when its consumer triggers %s",
    async (termination) => {
      vi.useFakeTimers();
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const controller = new AbortController();
      const chunks: string[] = [];
      const { registry, frames, invoke, invokeId } = invokeFixture({
        command: "agent.cli.claude.run.v1",
        timeoutMs: 100,
        idleTimeoutMs: 1_000,
        signal: controller.signal,
        onProgress: (chunk) => {
          chunks.push(chunk);
          if (termination === "deadline") {
            now = 1_100;
          } else if (termination === "abort") {
            controller.abort(Symbol("nodeInvokePairingChanged"));
          } else {
            throw new Error("parser failed");
          }
        },
      });

      expect(progress(registry, invokeId, 1, "buffered-after-deadline")).toBe(true);
      expect(chunks).toEqual([]);

      now = 1_050;
      expect(progress(registry, invokeId, 0, "first")).toBe(true);
      expect(chunks).toEqual(["first"]);
      if (termination === "consumer failure") {
        await expect(invoke).rejects.toThrow("parser failed");
      } else {
        await expect(invoke).resolves.toEqual(termination === "deadline" ? timedOut : aborted);
      }
      expectCancellation(frames, invokeId);
      expect(progress(registry, invokeId, 2, "late")).toBe(false);
      await vi.runOnlyPendingTimersAsync();
      expectCancellation(frames, invokeId);
    },
  );

  it("orders streamed invoke progress and drops state after the final result", async () => {
    const chunks: string[] = [];
    const { registry, invokeId, invoke } = invokeFixture({
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 100,
      onProgress: (chunk) => chunks.push(chunk),
    });

    expect(progress(registry, invokeId, 1, "second")).toBe(true);
    expect(chunks).toEqual([]);
    expect(progress(registry, invokeId, 0, "first")).toBe(true);
    expect(chunks).toEqual(["first", "second"]);
    expect(finish(registry, invokeId, { ok: true })).toBe(true);
    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(progress(registry, invokeId, 2, "late")).toBe(false);
  });

  it.each([
    { firstSeq: 0, timeoutMs: 0, deliveredChunks: [""], missingSeq: 1 },
    { firstSeq: 1, timeoutMs: 1_000, deliveredChunks: [], missingSeq: 0 },
  ])(
    "starts and preserves streamed idle timeout with first progress sequence $firstSeq",
    async ({ firstSeq, timeoutMs, deliveredChunks, missingSeq }) => {
      vi.useFakeTimers();
      const registry = createNodeRegistry();
      const chunks: string[] = [];
      const onTerminal = vi.fn();
      const { frames, invoke, invokeId } = startStreamingNodeInvoke(registry, {
        timeoutMs,
        idleTimeoutMs: 50,
        onProgress: (chunk) => chunks.push(chunk),
      });
      void invoke.then(onTerminal);

      // Empty ordered chunks are valid node-host liveness heartbeats.
      expect(progress(registry, invokeId, firstSeq, "")).toBe(true);
      expect(chunks).toEqual(deliveredChunks);

      for (const seq of [2, 3]) {
        await vi.advanceTimersByTimeAsync(20);
        expect(progress(registry, invokeId, seq, `future-${seq}`)).toBe(true);
        expect(chunks).toEqual(deliveredChunks);
        expect(progress(registry, invokeId, seq, `future-${seq}`)).toBe(false);
      }

      await vi.advanceTimersByTimeAsync(10);
      expect(onTerminal).toHaveBeenCalledExactlyOnceWith(idleTimedOut);
      expect(chunks).toEqual(deliveredChunks);
      expectCancellation(frames, invokeId);
      expect(progress(registry, invokeId, missingSeq, "missing")).toBe(false);
      await vi.runOnlyPendingTimersAsync();
      expectCancellation(frames, invokeId);
    },
  );

  it("bounds future progress behind a permanent sequence gap until idle teardown", async () => {
    vi.useFakeTimers();
    const { registry, invokeId, invoke } = invokeFixture({
      command: "agent.cli.claude.run.v1",
      timeoutMs: 10_000,
      idleTimeoutMs: 50,
      onProgress: () => {},
    });
    expect(progress(registry, invokeId, 0, "start")).toBe(true);

    for (let seq = 2; seq < 130; seq += 1) {
      expect(progress(registry, invokeId, seq, `future-${seq}`)).toBe(true);
    }
    expect(progress(registry, invokeId, 130, "over-cap")).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    await expect(invoke).resolves.toEqual(idleTimedOut);
  });

  it("resets streamed invoke idle timeout on progress", async () => {
    vi.useFakeTimers();
    const { registry, invokeId, invoke } = invokeFixture({
      command: "agent.cli.claude.run.v1",
      timeoutMs: 1_000,
      idleTimeoutMs: 50,
      onProgress: () => {},
    });

    // Approval can outlive the idle window; inactivity starts with execution progress.
    await vi.advanceTimersByTimeAsync(200);
    expect(progress(registry, invokeId, 0, "still running")).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(progress(registry, invokeId, 1, "still running")).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    await expect(invoke).resolves.toEqual(idleTimedOut);
  });

  it.each([
    { clientId: GATEWAY_CLIENT_IDS.NODE_HOST, command: "mcp.tools.call.v1" },
    { clientId: GATEWAY_CLIENT_IDS.MACOS_APP, command: "system.run" },
    { clientId: GATEWAY_CLIENT_IDS.IOS_APP, command: "system.run" },
  ])(
    "preserves negotiated non-streaming cancellation for $clientId $command",
    async ({ clientId, command }) => {
      const registry = createNodeRegistry();
      const frames = registerNode(registry, { clientId });
      const controller = new AbortController();
      const invoke = registry.invoke({
        nodeId: "node-1",
        command,
        timeoutMs: 1_000,
        signal: controller.signal,
      });
      const request = readRequest(frames);

      controller.abort();

      await expect(invoke).resolves.toMatchObject({
        ok: false,
        error: { code: "ABORTED" },
      });
      if (clientId === GATEWAY_CLIENT_IDS.IOS_APP) {
        expect(frames).toHaveLength(1);
      } else {
        expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
          event: "node.invoke.cancel",
          payload: { invokeId: request.id, nodeId: "node-1" },
        });
      }
    },
  );

  it("expires system.run authorization when the process clock is invalid", () => {
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke } = invokeSystemRun(registry, frames, {
      runId: "run-invalid-clock",
      sessionKey: "agent:main:main",
      timeoutMs: 1_000,
    });
    void invoke.catch(() => {});

    expect(authorizeRun(registry, { runId: "run-invalid-clock" })).toBe(false);
  });

  it("allows legacy run-id fallback only for a single matching event window", () => {
    const registry = createTestNodeRegistry();
    const frames = registerNode(registry);
    const { invoke, request } = invokeSystemRun(registry, frames, { command: ["printf", "ok"] });
    const { runId } = JSON.parse(request.paramsJSON ?? "{}");
    expect(runId).toEqual(expect.any(String));
    expect(authorizeRun(registry, { runId, terminal: false })).toBe(true);
    expect(authorizeRun(registry, { terminal: false })).toBe(true);
    expect(authorizeRun(registry, { runId: "legacy-runtime-run", terminal: false })).toBe(true);
    const { invoke: second } = invokeSystemRun(registry, frames, {
      runId: "run-b",
      sessionKey: "agent:main:main",
    });
    expect(authorizeRun(registry)).toBe(false);
    expect(authorizeRun(registry, { runId })).toBe(true);
    registry.unregister("conn-1");
    void invoke.catch(() => {});
    void second.catch(() => {});
  });

  it("sends raw event payload JSON without changing the envelope shape", () => {
    const registry = createTestNodeRegistry();
    const frames: string[] = [];
    registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {});
    const payload = serializeEventPayload({ foo: "bar" });
    const nullPayload = serializeEventPayload(null);
    const falsePayload = serializeEventPayload(false);
    const zeroPayload = serializeEventPayload(0);
    const emptyStringPayload = serializeEventPayload("");

    expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "nullish", nullPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "flag", falsePayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "count", zeroPayload)).toBe(true);
    expect(registry.sendEventRaw("node-1", "empty", emptyStringPayload)).toBe(true);
    expect(registry.sendEventRaw("missing-node", "chat", payload)).toBe(false);
    expect(registry.sendEventRaw("node-1", "heartbeat", null)).toBe(true);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        "not-json" as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);
    expect(
      registry.sendEventRaw(
        "node-1",
        "chat",
        '{"x":1},"seq":999' as unknown as Parameters<NodeRegistry["sendEventRaw"]>[2],
      ),
    ).toBe(false);

    expect(frames).toEqual([
      '{"type":"event","event":"chat","payload":{"foo":"bar"}}',
      '{"type":"event","event":"nullish","payload":null}',
      '{"type":"event","event":"flag","payload":false}',
      '{"type":"event","event":"count","payload":0}',
      '{"type":"event","event":"empty","payload":""}',
      '{"type":"event","event":"heartbeat"}',
    ]);
  });

  it("rate-limits failed event delivery warnings for registered nodes", async () => {
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(resolvePreferredOpenClawTmpDir(), `node-event-send-${process.pid}.log`),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      socket: createTestNodeSocket([], WebSocket.CLOSING) as unknown as GatewayWsClient["socket"],
    });
    registerNodeSession(registry, client, {});

    try {
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);

      now.mockReturnValue(31_001);
      expect(registry.sendEventRaw("node-1", "raw.failed", null)).toBe(false);
      now.mockReturnValue(61_002);
      expect(registry.sendEvent("node-1", "normal.failed", {})).toBe(false);

      client.invalidated = true;
      expect(registry.sendEvent("node-1", "invalidated.failed", {})).toBe(false);
      expect(registry.unregister("conn-1")).toBe("node-1");
      expect(registry.sendEvent("node-1", "unregistered.failed", {})).toBe(false);
      await capture.flush();

      const warnings = capture.records.filter(
        (record) => record.message === "node event delivery failed",
      );
      expect(warnings.map((record) => record.attributes)).toEqual([
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "raw.failed" }),
        expect.objectContaining({ nodeId: "node-1", event: "normal.failed" }),
      ]);
    } finally {
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
      now.mockRestore();
    }
  });

  it.each([
    "socket_not_open",
    "socket_buffer_limit",
    "send_or_serialization_exception",
    "pairing_not_current",
    "pairing_state_unavailable",
    "event_transport_refused",
  ])("correlates bundle invoke refusal %s without exporting payloads", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({ level: "warn", consoleLevel: "silent" });
    let pairingCurrent = true;
    let pairingUnavailable = false;
    const { nodeRegistry: registry, nodeWorkerSupervisorTransport: transport } =
      createPrivateRegistry({
        isPairingStateCurrent: () => {
          if (pairingUnavailable) {
            throw new Error("private pairing failure");
          }
          return pairingCurrent;
        },
      });
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const client = makeClient("conn-1", "node-1", [], {
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      socket: socket as unknown as GatewayWsClient["socket"],
    });
    if (reason === "event_transport_refused") {
      registry.registerTransport(client, pairingA, {
        send: () => false,
        sendRaw: () => false,
      });
    } else {
      registerNodeSession(registry, client, pairingA);
    }
    publishRunner(registry, { enabled: true, capacity: { total: 1, available: 1 } });
    const node = expectDefined(await transport.getCurrentNode("node-1"), "current runner");
    if (reason === "socket_not_open") {
      socket.readyState = WebSocket.CLOSING;
    } else if (reason === "socket_buffer_limit") {
      socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    } else if (reason === "send_or_serialization_exception") {
      socket.send.mockImplementation(() => {
        throw new Error("private transport error");
      });
    } else if (reason === "pairing_not_current") {
      pairingCurrent = false;
    } else if (reason === "pairing_state_unavailable") {
      pairingUnavailable = true;
    }
    const onDispatchReady = vi.fn();
    try {
      await expect(
        runWithDiagnosticTraceContext({ traceId: "a".repeat(32), spanId: "b".repeat(16) }, () =>
          transport.invoke({
            node,
            command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
            params: { token: "private-download-authority", url: "https://private.invalid/archive" },
            timeoutMs: 0,
            isDispatchAuthorized: () => true,
            onDispatchReady,
          }),
        ),
      ).resolves.toEqual(failure("UNAVAILABLE", "failed to send invoke to node"));
      expect(onDispatchReady).not.toHaveBeenCalled();
      await capture.flush();
      const refusals = capture.records.filter(
        (record) => record.message === "node invoke dispatch refused",
      );
      expect(refusals).toEqual([
        expect.objectContaining({
          trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
          attributes: expect.objectContaining({
            nodeId: "node-1",
            connId: "conn-1",
            invokeId: expect.any(String),
            command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
            reason,
            remoteEffects: "unknown",
            ...(reason.startsWith("socket_") || reason === "send_or_serialization_exception"
              ? { socketReadyState: socket.readyState, bufferedBytes: socket.bufferedAmount }
              : {}),
          }),
        }),
      ]);
      const records = JSON.stringify(capture.records);
      expect(records).not.toContain("private-download-authority");
      expect(records).not.toContain("private.invalid");
      expect(records).not.toContain("private transport error");
      expect(records).not.toContain("private pairing failure");
      if (reason !== "send_or_serialization_exception") {
        expect(socket.send).not.toHaveBeenCalled();
      }
      if (reason === "socket_buffer_limit") {
        expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
      }
    } finally {
      socket.emit("close");
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it.each(["generation", "identity", "connection"])(
    "drops a delayed snapshot when pairing %s changes",
    async (change) => {
      const lookup = createDeferred<{ identity: string; generation?: string } | undefined>();
      const resolveCurrentPairingState = vi.fn(() => lookup.promise);
      const registry = createNodeRegistry({ resolveCurrentPairingState });
      const frames: string[] = [];
      const replacementFrames: string[] = [];
      registerNodeSession(
        registry,
        makeClient("conn-1", "node-1", frames),
        change === "identity" ? { pairingIdentity: "identity-a" } : pairingA,
      );

      const send =
        change === "generation"
          ? registry.sendEventRawForPairingGeneration(
              "node-1",
              "generation-a",
              "voicewake.changed",
              serializeEventPayload({ triggers: ["openclaw"] }),
            )
          : registry.sendEventForPairingIdentity({
              nodeId: "node-1",
              connId: "conn-1",
              pairingIdentity: "identity-a",
              event: change === "identity" ? "voicewake.changed" : "node.pair.resolved",
              payload:
                change === "identity"
                  ? { triggers: ["openclaw"] }
                  : { nodeId: "node-1", decision: "approved", requestId: "approval-1", ts: 1 },
            });
      if (change === "generation") {
        await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledTimes(1));
      }
      if (change === "connection") {
        registerNodeSession(registry, makeClient("conn-2", "node-1", replacementFrames), pairingA);
      }
      lookup.resolve(
        change === "identity"
          ? undefined
          : {
              identity: "identity-a",
              generation: change === "generation" ? "generation-b" : "generation-a",
            },
      );

      await expect(send).resolves.toBe(false);
      expect(frames).toEqual([]);
      expect(replacementFrames).toEqual([]);
      if (change === "identity") {
        await expect(registry.listCurrentConnected()).resolves.toEqual([]);
      }
    },
  );

  it.each(["grace timeout", "close event"])(
    "retires saturated node sockets after %s",
    (completion) => {
      vi.useFakeTimers();
      resetDiagnosticEventsForTest();
      const diagnosticEvents: unknown[] = [];
      const stopDiagnostics = onDiagnosticEvent((event) => diagnosticEvents.push(event));
      const registry = createTestNodeRegistry();
      const socket = Object.assign(new EventEmitter(), {
        readyState: WebSocket.OPEN,
        bufferedAmount: MAX_BUFFERED_BYTES + 1,
        send: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
      });
      registerSocket(registry, socket);
      const payload = serializeEventPayload({ foo: "bar" });

      try {
        expect(registry.sendEventRaw("node-1", "chat", payload)).toBe(false);
        expect(socket.send).not.toHaveBeenCalled();
        expect(socket.close).toHaveBeenCalledWith(1008, "slow consumer");
        expect(socket.terminate).not.toHaveBeenCalled();
        if (completion === "close event") {
          socket.emit("close", 1008, Buffer.from("slow consumer"));
        }
        vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
        if (completion === "close event") {
          expect(socket.terminate).not.toHaveBeenCalled();
        } else {
          expect(socket.terminate).toHaveBeenCalledOnce();
          vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
          expect(socket.terminate).toHaveBeenCalledOnce();
          expect(socket.close.mock.invocationCallOrder[0]).toBeLessThan(
            socket.terminate.mock.invocationCallOrder[0]!,
          );
        }
        expect(diagnosticEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "payload.large",
              action: "rejected",
              surface: "gateway.ws.outbound_buffer",
              bytes: MAX_BUFFERED_BYTES + 1,
              limitBytes: MAX_BUFFERED_BYTES,
              reason: "ws_send_buffer_close",
            }),
          ]),
        );
      } finally {
        stopDiagnostics();
        resetDiagnosticEventsForTest();
      }
    },
  );

  it("refreshes effective live surface within the declared surface", () => {
    const registry = createTestNodeRegistry();
    const computerUse = computerUseDescriptor();
    const client = makeClient("conn-1", "node-1", [], {
      caps: [],
      commands: [],
      declaredCaps: ["talk", "screen"],
      sessionCapsCeiling: ["talk"],
      declaredCommands: ["talk.ptt.start", "computer.act", "screen.snapshot", "system.run"],
      sessionCommandsCeiling: ["talk.ptt.start", "computer.act", "screen.snapshot"],
      computerUse,
      declaredComputerUse: computerUse,
      declaredPermissions: { microphone: true, camera: false, accessibility: true },
      permissions: { accessibility: true },
    });

    const session = registerNodeSession(registry, client, {});
    expect(session.caps).toEqual([]);
    expect(session.commands).toEqual([]);
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");

    const updated = registry.updateSurface("node-1", {
      caps: ["talk", "screen"],
      commands: ["talk.ptt.start", "computer.act", "screen.snapshot", "system.run"],
      permissions: { microphone: true, camera: true },
    });

    expect(updated?.caps).toEqual(["talk"]);
    expect(updated?.commands).toEqual(["talk.ptt.start", "computer.act", "screen.snapshot"]);
    expect(updated?.computerUse).toEqual(computerUse);
    expect(updated?.permissions).toEqual({ microphone: true, camera: false });
    expect(client.connect.caps).toEqual(["talk"]);
    expect((client.connect as { commands?: string[] }).commands).toEqual([
      "talk.ptt.start",
      "computer.act",
      "screen.snapshot",
    ]);
    expect(client.connect.computerUse).toEqual(computerUse);
    expect(session.lastActiveAtMs).toBeUndefined();
    expect(session.presenceUpdatedAtMs).toBeUndefined();
    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
    registry.updateSurface("node-1", { commands: [], permissions: undefined });
    expect(registry.get("node-1")?.permissions).toBeUndefined();
    expect(client.connect.permissions).toBeUndefined();
  });

  it.each([true, false])(
    "preserves invoke generation binding across promotion (bound=%s)",
    async (bound) => {
      const registry = createNodeRegistry();
      const frames: string[] = [];
      const chunks: string[] = [];
      registerNodeSession(
        registry,
        makeClient("conn-1", "node-1", frames, {
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          commands: ["system.run"],
          permissions: { accessibility: true },
          declaredPermissions: { accessibility: true },
        }),
        pairingA,
      );
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-1",
        idleSeconds: 0,
        observedAtMs: 100_000,
      });
      expect(registry.getForPairingGeneration("node-1", "generation-b")).toBeUndefined();
      expect(registry.getForPairingGeneration("node-1", "generation-a")?.connId).toBe("conn-1");
      await expect(
        registry.invoke({
          nodeId: "node-1",
          expectedPairingGeneration: "generation-b",
          command: "system.run",
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "PAIRING_CHANGED" } });
      expect(registry.get("node-1")?.client.invalidated).not.toBe(true);
      expect(frames).toEqual([]);
      const invoke = registry.invoke({
        nodeId: "node-1",
        ...(bound ? { expectedConnId: "conn-1", expectedPairingGeneration: "generation-a" } : {}),
        command: "system.run",
        params: { runId: "run-generation", sessionKey: "agent:main:main", timeoutMs: 0 },
        timeoutMs: 0,
        onProgress: (chunk) => chunks.push(chunk),
      });
      const request = readRequest(frames);
      const invokeId = request.id ?? "";
      expect(authorizeRun(registry, { runId: "run-generation", terminal: false })).toBe(true);

      expect(
        registry.updateSurface(
          "node-1",
          { commands: [] },
          {
            expectedConnId: "conn-stale",
            expectedPairingIdentity: "identity-a",
            expectedPairingGeneration: "generation-a",
            nextPairingGeneration: "generation-c",
          },
        ),
      ).toBeNull();
      expect(registry.get("node-1")?.pairingGeneration).toBe("generation-a");
      expect(registry.get("node-1")?.commands).toEqual(["system.run"]);
      registry.updateSurface("node-1", { commands: ["system.run"] }, generationTransition);

      expect(getCurrentActiveNodeContext()).toMatchObject({
        nodeId: "node-1",
        pairingGeneration: "generation-b",
      });
      if (bound) {
        await expect(invoke).resolves.toEqual(
          failure("PAIRING_CHANGED", "node pairing changed after dispatch"),
        );
        expect(authorizeRun(registry, { runId: "run-generation", terminal: false })).toBe(false);
        expect(progress(registry, invokeId, 0, "late")).toBe(false);
        expect(finish(registry, invokeId, { ok: true })).toBe(false);
        expect(() => registry.sendInvokeInput(invokeId, { kind: "data", data: "late" })).toThrow(
          "node invoke is not pending",
        );
        expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
          event: "node.invoke.cancel",
          payload: { invokeId, nodeId: "node-1" },
        });
        expect(frames).toHaveLength(2);
      } else {
        expect(progress(registry, invokeId, 0, "current")).toBe(true);
        registry.sendInvokeInput(invokeId, { kind: "data", data: "current" });
        expect(finish(registry, invokeId, { ok: true })).toBe(true);
        await expect(invoke).resolves.toMatchObject({ ok: true });
        expect(chunks).toEqual(["current"]);
        expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
          event: "node.invoke.input",
          payload: { id: invokeId, seq: 0 },
        });
      }
    },
  );

  it("does not promote a generation-less session from a retired pairing identity", () => {
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], { declaredCommands: ["device.info"] });
    registerNodeSession(registry, client, { pairingIdentity: "identity-a" });

    expect(
      registry.updateSurface(
        "node-1",
        { commands: ["device.info"] },
        {
          expectedConnId: "conn-1",
          expectedPairingIdentity: "identity-b",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).toBeNull();
    expect(registry.get("node-1")).toMatchObject({ pairingIdentity: "identity-a", commands: [] });
    expect(registry.get("node-1")?.pairingGeneration).toBeUndefined();
  });

  it("keeps node-hosted plugin tools inside the approved command surface", () => {
    registerTool({ name: "demo_echo", command: "demo.echo" });
    const registry = createTestNodeRegistry();
    const client = makeClient("conn-1", "node-1", [], {
      commands: [],
      declaredCommands: ["demo.echo"],
    });

    const session = registerNodeSession(registry, client, {});
    publishTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Echo through the node",
        command: "demo.echo",
      },
      {
        pluginId: "demo",
        name: "demo.echo",
        description: "Invalid provider name",
        command: "demo.echo",
      },
      {
        pluginId: "demo",
        name: "demo_blocked",
        description: "Blocked command",
        command: "demo.blocked",
      },
    ]);

    expect(session.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);
    registry.updateSurface("node-1", { commands: ["demo.echo"] });
    expect(session.nodePluginTools.map((tool) => tool.name)).toEqual(["demo_echo"]);
    expect(listConnectedNodePluginTools().map((entry) => entry.descriptor.name)).toEqual([
      "demo_echo",
    ]);

    registry.updateSurface("node-1", { caps: [], commands: [] });

    expect(registry.get("node-1")?.nodePluginTools).toEqual([]);
    registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { commands: ["demo.echo"] }),
    );
    expect(
      publishTools(registry, [
        { pluginId: "demo", name: "demo_echo", description: "Stale", command: "demo.echo" },
      ]),
    ).toBeNull();
    expect(registry.get("node-1")?.nodePluginTools).toEqual([]);
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("enriches published node tools after matching plugin descriptors load", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { commands: ["demo.echo"] }),
      {},
    );
    publishTools(registry, [
      {
        pluginId: "demo",
        name: "demo_echo",
        description: "Published description",
        command: "demo.echo",
      },
    ]);

    expect(registry.get("node-1")?.nodePluginTools[0]?.description).toBe("Published description");

    registerTool({
      name: "demo_echo",
      command: "demo.echo",
      description: "Registered description",
    });
    registry.refreshRuntimePolicy();

    expect(registry.get("node-1")?.nodePluginTools[0]?.description).toBe("Registered description");
  });

  it("enforces node skill count and total-content caps", () => {
    const registry = createTestNodeRegistry();
    registerNodeSession(registry, makeClient("conn-1", "node-1"), {});

    const countUpdate = publishSkills(registry, [
      { ...nodeSkill("broken"), content: "x".repeat(64 * 1024 + 1) },
      ...Array.from({ length: 65 }, (_, index) =>
        nodeSkill(`count-${String(index).padStart(2, "0")}`),
      ),
    ]);
    expect(countUpdate?.nodeSkills).toHaveLength(64);
    expect(countUpdate?.nodeSkills.some((skill) => skill.name === "broken")).toBe(false);

    const totalUpdate = publishSkills(
      registry,
      Array.from({ length: 9 }, (_, index) =>
        nodeSkill(`large-${String(index).padStart(2, "0")}`, "x".repeat(60 * 1024)),
      ),
    );
    expect(totalUpdate?.nodeSkills).toHaveLength(8);
  });

  it("ignores node skills when publication is disabled or the connection is stale", () => {
    const disabled = createNodeRegistry({
      getConfig: () => ({ gateway: { nodes: { allowSkills: false } } }),
    });
    registerNodeSession(disabled, makeClient("conn-1", "node-1"), {});
    expect(publishSkills(disabled, [nodeSkill("disabled")])?.nodeSkills).toEqual([]);

    const registry = createTestNodeRegistry();
    registerNodeSession(registry, makeClient("conn-old", "node-1"), {});
    registerNodeSession(registry, makeClient("conn-new", "node-1"), {});
    expect(publishSkills(registry, [nodeSkill("stale")], "conn-old")).toBeNull();
    expect(registry.get("node-1")?.nodeSkills).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("node registry presence", () => {
  it("recomputes active context when a same-id connection replaces reported presence", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-old", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-old",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-old",
        idleSeconds: 0,
        observedAtMs: 100_000,
      }),
    ).toBeNull();
    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
    expect(registry.unregister("conn-old")).toBeNull();
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("keeps requester presence separate from other people and shared computers", () => {
    const registry = createNodeRegistry();
    for (const [nodeId, profileId, idleSeconds] of [
      ["alice-mac", "alice", 10],
      ["alice-laptop", "alice", 5],
      ["bob-mac", "bob", 1],
      ["shared-mac", "gateway-owner", 0],
    ] as const) {
      const client = makeClient(nodeId, nodeId, []);
      client.authenticatedUserProfile = {
        profileId,
        displayName: profileId,
        avatarRevision: "0",
        hasAvatar: false,
        updatedAt: 0,
      };
      registerNodeSession(registry, client, {});
      registry.updatePresenceActivity({
        nodeId,
        connId: nodeId,
        idleSeconds,
        source: "app",
        observedAtMs: 100_000,
      });
    }

    expect(registry.getActiveNode()?.nodeId).toBe("shared-mac");
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("alice-laptop");
    expect(getCurrentActiveNodeContext("bob")?.nodeId).toBe("bob-mac");
    expect(getCurrentActiveNodeContext("absent-person")).toBeNull();
    expect(buildActiveNodeContextText("alice")).toContain(
      "active_node=alice-laptop active_node_identity=requester",
    );
    expect(buildActiveNodeContextText("gateway-owner")).toContain(
      "active_node=shared-mac active_node_identity=unknown",
    );
    expect(getCurrentActiveNodeContext()?.nodeId).toBe("shared-mac");

    registry.unregister("alice-laptop");
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("alice-mac");
    registry.unregister("alice-mac");
    expect(getCurrentActiveNodeContext("alice")).toBeNull();
    expect(getCurrentActiveNodeContext("bob")?.nodeId).toBe("bob-mac");

    const profile = expectDefined(
      registry.get("bob-mac")?.client.authenticatedUserProfile,
      "Bob's authenticated profile",
    );
    profile.profileId = "alice";
    expect(getCurrentActiveNodeContext("bob")).toBeNull();
    expect(getCurrentActiveNodeContext("alice")).toBeNull();
    registry.updatePresenceActivity({
      nodeId: "bob-mac",
      connId: "bob-mac",
      idleSeconds: 0,
      source: "app",
      observedAtMs: 110_000,
    });
    expect(getCurrentActiveNodeContext("bob")).toBeNull();
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("bob-mac");
  });

  it("does not advance a bounded estimate on saturated idle keepalives", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    const first = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_000_000,
    });
    const keepalive = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_180_000,
    });

    expect(first?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.presenceUpdatedAtMs).toBe(3_000_180_000);
  });

  it("clears presence only for the current connection and selects the next active Mac", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registerNodeSession(
      registry,
      makeClient("conn-2", "node-2", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 10,
      observedAtMs: 100_000,
    });
    registry.updatePresenceActivity({
      nodeId: "node-2",
      connId: "conn-2",
      idleSeconds: 0,
      observedAtMs: 105_000,
    });

    expect(registry.get("node-1")).toMatchObject({
      lastActiveAtMs: 90_000,
      presenceUpdatedAtMs: 100_000,
    });
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-old" })).toBeNull();
    expect(registry.getActiveNode()?.nodeId).toBe("node-2");
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(true);
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-1" });
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(false);
    expect(registry.unregister("conn-1")).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toBeNull();
  });
});
