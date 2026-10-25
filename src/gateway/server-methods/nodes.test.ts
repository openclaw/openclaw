import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import {
  captureNodePairingGeneration,
  isPairedDeviceNodeBindingCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "../../infra/device-pairing-node-state.js";
import * as nodePairing from "../../infra/device-pairing-node.js";
import { rotateDeviceToken } from "../../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingState,
} from "../../infra/device-pairing.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { loadApnsRegistration, registerApnsRegistration } from "../../infra/push-apns.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { resetRemoteNodeSkillsForTests } from "../../skills/runtime/remote-skills.test-support.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "../node-pending-work.js";
import { createNodeRegistryRuntime } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { captureNodeWakeLifecycle } from "../node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
  seedNodeWakeState,
} from "../node-wake-state.test-support.js";
import { bindDeviceWorkerReconciliation } from "../worker-environments/device-provider.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const createdStates: OpenClawTestState[] = [];

async function captureNodePairingState(nodeId: string) {
  return resolveNodePairingState(await getPairedDevice(nodeId));
}

async function createNodeState(
  nodeId: string,
  options: { role?: "node" | "operator"; surface?: boolean } = {},
) {
  const state = await createOpenClawTestState({ label: nodeId, layout: "state-only" });
  createdStates.push(state);
  await pairAndroidNodeDevice(state.stateDir, nodeId, options.role);
  if (options.surface) {
    await approveNodeSurface(state.stateDir, nodeId);
  }
  return { stateDir: state.stateDir, nodeId };
}

function registerApns(
  nodeId: string,
  overrides: Partial<
    Extract<Parameters<typeof registerApnsRegistration>[0], { transport?: "direct" }>
  > = {},
) {
  return registerApnsRegistration({
    nodeId,
    transport: "direct",
    token: "ABCD1234ABCD1234ABCD1234ABCD1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    ...overrides,
  });
}

afterEach(async () => {
  resetDiagnosticEventsForTest();
  resetRemoteNodeSkillsForTests();
  resetNodeWakeStateForTest();
  vi.clearAllMocks();
  await closeStateDatabaseForTest();
  while (createdStates.length > 0) {
    await createdStates.pop()?.cleanup();
  }
});

function captureSecurityEvents() {
  const events: Extract<DiagnosticEventPayload, { type: "security.event" }>[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

function createContext() {
  return {
    broadcast: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    invalidateClientsForDevice: vi.fn(),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: Object.assign(new NodeRegistry(), {
      get: vi.fn(),
      listConnected: vi.fn(() => []),
      listConnectedForPairingStates: vi.fn(() => []),
      getActiveNode: vi.fn(),
      updateSurface: vi.fn(),
      updateNodeSkills: vi.fn(),
    }),
  };
}

function createClient(scopes: string[], deviceId?: string, opts?: { isDeviceTokenAuth?: boolean }) {
  return {
    ...(opts?.isDeviceTokenAuth !== undefined ? { isDeviceTokenAuth: opts.isDeviceTokenAuth } : {}),
    connect: {
      scopes,
      ...(deviceId ? { device: { id: deviceId } } : {}),
    },
  } as never;
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
  registry?: NodeRegistry,
) {
  const context = createContext();
  if (registry) {
    Object.assign(context, { nodeRegistry: registry });
  }
  const respond = vi.fn();
  const opts = {
    req: { type: "req", id: "req-1", method: "node.pair.remove", params },
    params,
    client: createClient(["operator.pairing", "operator.admin"]),
    isWebchatConnect: () => false,
    respond,
    context,
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return { context, opts, respond };
}

function invokeNode(method: string, opts: GatewayRequestHandlerOptions) {
  return expectDefined(nodeHandlers[method], `${method} test invariant`)(opts);
}

function expectSuccess(opts: GatewayRequestHandlerOptions, payload: unknown) {
  expect(opts.respond).toHaveBeenCalledWith(true, payload, undefined);
}

async function publishRunner(
  registry: NodeRegistry,
  client: ReturnType<typeof createWorkerSupervisorNodeClient>,
) {
  const publication = createOptions(
    {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity: { total: 2, available: 2 },
      },
    },
    { client: client as never },
    registry,
  );
  await invokeNode("node.runnerInventory.update", publication.opts);
}

function connectNode(
  nodeId: string,
  pairingState: Awaited<ReturnType<typeof captureNodePairingState>>,
  registry: NodeRegistry,
  connId = "conn-1",
) {
  const client = createWorkerSupervisorNodeClient(connId);
  client.connect.device = { ...client.connect.device!, id: nodeId };
  const send = vi.spyOn(client.socket, "send");
  registry.register(client, {
    pairingIdentity: pairingState?.identity.key ?? "",
    pairingGeneration: pairingState?.generation?.key,
  });
  return { client, send };
}

function expectDisconnected(context: ReturnType<typeof createContext>, nodeId: string) {
  expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
    role: "node",
    reason: "device-pair-removed",
  });
  expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
}

it("node.skills.update stores and publishes a validated replacement catalog for the calling node", async () => {
  const skill = {
    name: "release-helper",
    description: "Prepare a release",
    content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
  };
  const { context, opts } = createOptions(
    { skills: [skill] },
    {
      client: {
        connId: "conn-1",
        connect: { device: { id: "node-1" }, client: { id: "node-client" } },
      } as never,
    },
  );
  context.nodeRegistry.updateNodeSkills.mockReturnValue({
    nodeId: "node-1",
    nodeSkills: [skill],
  });

  await invokeNode("node.skills.update", opts);

  expect(context.nodeRegistry.updateNodeSkills).toHaveBeenCalledWith("node-1", "conn-1", [skill]);
  expectSuccess(opts, { nodeId: "node-1", skills: [skill] });
});

function expectApproved(opts: GatewayRequestHandlerOptions, nodeId: string) {
  expectSuccess(opts, expect.objectContaining({ node: expect.objectContaining({ nodeId }) }));
}

const androidSurface = {
  platform: "android",
  deviceFamily: "Android",
  clientId: "openclaw-android",
  clientMode: "node",
};

async function pairAndroidNodeDevice(
  stateDir: string,
  nodeId: string,
  role: "node" | "operator" = "node",
): Promise<void> {
  const scopes = role === "operator" ? ["operator.pairing"] : [];
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      ...androidSurface,
      role,
      roles: role === "operator" ? ["operator", "node"] : ["node"],
      scopes,
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: scopes },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}

function requestSurface(stateDir: string, nodeId: string, displayName: string) {
  return nodePairing.requestNodePairing({ nodeId, ...androidSurface, displayName }, stateDir);
}

async function approveNodeSurface(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestSurface(stateDir, nodeId, "Galaxy A54 5G");
  const approved = await nodePairing.approveNodePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing"] },
    stateDir,
  );
  expect(approved).toEqual(expect.objectContaining({ node: expect.objectContaining({ nodeId }) }));
}

describe("nodeHandlers node.pair.approve", () => {
  it("promotes a node that connects while its first surface approval is pending", async () => {
    const { stateDir, nodeId } = await createNodeState("node-connect-during-approval");
    const pairingState = expectDefined(await captureNodePairingState(nodeId), "paired node");
    expect(pairingState.generation).toBeNull();
    const pending = await nodePairing.requestNodePairing(
      { nodeId, caps: ["system"], commands: ["system.run"] },
      stateDir,
    );
    const registry = new NodeRegistry({
      resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
      isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
    });
    const client = createWorkerSupervisorNodeClient("conn-during-approval");
    Object.assign(client.connect, {
      device: { id: nodeId },
      commands: [],
      declaredCaps: ["system"],
      declaredCommands: ["system.run"],
    });
    const approve = nodePairing.approveNodePairing;
    const approval = vi
      .spyOn(nodePairing, "approveNodePairing")
      .mockImplementation(async (...args) => {
        registry.register(client, { pairingIdentity: pairingState.identity.key });
        expect(registry.get(nodeId)?.commands).toEqual([]);
        return await approve(...args);
      });
    const { opts } = createOptions({ requestId: pending.request.requestId }, undefined, registry);
    try {
      await invokeNode("node.pair.approve", opts);
      expectApproved(opts, nodeId);
      const approved = expectDefined(await captureNodePairingState(nodeId), "approved node");
      expect(approved.identity.key).toBe(pairingState.identity.key);
      expect(approved.generation).not.toBeNull();
      expect(registry.get(nodeId)?.commands).toEqual(["system.run"]);
      expect(registry.get(nodeId)?.pairingGeneration).toBe(
        (await captureNodePairingGeneration(nodeId))?.key,
      );
      await expect(registry.getCurrentConnected(nodeId)).resolves.toBeDefined();
    } finally {
      approval.mockRestore();
      registry.unregister(client.connId);
    }
  });

  it("requires current-generation runner inventory after exact live reapproval", async () => {
    const { stateDir, nodeId } = await createNodeState("node-1", { surface: true });
    const previousState = await captureNodePairingState(nodeId);
    expect(previousState?.generation).not.toBeNull();

    const inspectPublishedSurface = vi.fn<() => void>();
    const runtime = createNodeRegistryRuntime(
      () =>
        new NodeRegistry({
          listRegisteredNodePluginToolCommands: () => {
            inspectPublishedSurface();
            return [];
          },
          resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
          isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
        }),
    );
    const client = createWorkerSupervisorNodeClient("conn-surface-reapproval");
    client.connect.permissions = { accessibility: true };
    const send = vi.spyOn(client.socket, "send");
    runtime.nodeRegistry.register(client, {
      pairingIdentity: previousState?.identity.key ?? "",
      pairingGeneration: previousState?.generation?.key,
    });
    await publishRunner(runtime.nodeRegistry, client);
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({ pairingGeneration: previousState?.generation?.key }),
    ]);

    const pending = await nodePairing.requestNodePairing(
      {
        nodeId,
        platform: "linux",
        deviceFamily: "Linux",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        displayName: "Worker host reapproved",
        permissions: { accessibility: false },
      },
      stateDir,
    );
    const lifecycle = captureNodeWakeLifecycle(nodeId);
    const approval = createOptions(
      { requestId: pending.request.requestId },
      undefined,
      runtime.nodeRegistry,
    );
    inspectPublishedSurface.mockClear();
    inspectPublishedSurface.mockImplementation(() => {
      const session = runtime.nodeRegistry.get(nodeId);
      expect(session?.permissions).toEqual({ accessibility: false });
      expect(client.connect.permissions).toEqual({ accessibility: false });
      expect(session?.pairingGeneration).not.toBe(previousState?.generation?.key);
    });
    let reconciledBeforeReply = false;
    const delivery = probe.command(stateWorker, async (command, executeOptions, scope) => {
      const result = await scope.execute(command, executeOptions);
      if (command.type === "node.approve") {
        // A notification can reconcile connections after COMMIT, before the RPC resumes.
        runtime.nodeRegistry.listCurrentConnectedSync();
        reconciledBeforeReply = true;
        expect(client.invalidated).not.toBe(true);
        expect(runtime.nodeRegistry.get(nodeId)?.pairingGeneration).not.toBe(
          previousState?.generation?.key,
        );
      }
      return result;
    });
    try {
      await invokeNode("node.pair.approve", approval.opts);
    } finally {
      delivery.mockRestore();
    }

    expect(reconciledBeforeReply).toBe(true);
    expect(inspectPublishedSurface).toHaveBeenCalled();
    expect(lifecycle.aborted).toBe(true);
    const nextGeneration = await captureNodePairingGeneration(nodeId);
    expect(nextGeneration?.key).not.toBe(previousState?.generation?.key);
    expectApproved(approval.opts, nodeId);
    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([]);
    const message = send.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(message))).toMatchObject({
      type: "event",
      event: "node.pair.resolved",
      payload: { requestId: pending.request.requestId, nodeId, decision: "approved" },
    });
    await publishRunner(runtime.nodeRegistry, client);

    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        connId: "conn-surface-reapproval",
        pairingGeneration: nextGeneration?.key,
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-surface-reapproval");
  });

  it.each(["before approval", "after surface commit", "node-token rotation"])(
    "does not deliver approval to the old session after %s",
    async (timing) => {
      const rotation = timing === "node-token rotation";
      const { stateDir, nodeId } = await createNodeState("node-reapproval-race", {
        surface: !rotation,
      });
      const staleState = expectDefined(await captureNodePairingState(nodeId), "paired node");
      if (rotation) {
        expect(staleState.generation).toBeNull();
      } else {
        expectDefined(staleState.generation, "approved surface");
      }
      const pending = await requestSurface(stateDir, nodeId, "Galaxy A54 5G reapproved");
      if (rotation) {
        expect(
          await rotateDeviceToken({
            deviceId: nodeId,
            role: "node",
            scopes: [],
            baseDir: stateDir,
          }),
        ).toMatchObject({ ok: true });
        const current = await captureNodePairingState(nodeId);
        expect(current?.generation).toBeNull();
        expect(current?.identity.key).not.toBe(staleState.identity.key);
      }
      const registry = new NodeRegistry({
        resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
        isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
      });
      const { client, send } = connectNode(nodeId, staleState, registry);
      const approve = nodePairing.approveNodePairing;
      const approval = vi.spyOn(nodePairing, "approveNodePairing");
      if (timing === "before approval") {
        await pairAndroidNodeDevice(stateDir, nodeId);
        expect((await captureNodePairingGeneration(nodeId))?.key).not.toBe(
          staleState.generation?.key,
        );
      } else if (!rotation) {
        approval.mockImplementation(async (...args) => {
          const result = await approve(...args);
          await pairAndroidNodeDevice(stateDir, nodeId);
          return result;
        });
      }
      const { opts } = createOptions({ requestId: pending.request.requestId }, undefined, registry);
      try {
        await invokeNode("node.pair.approve", opts);
        if (!rotation) {
          expect((await captureNodePairingGeneration(nodeId))?.key).not.toBe(
            staleState.generation?.key,
          );
        }
        expect(send).not.toHaveBeenCalled();
        await expect(registry.getCurrentConnected(nodeId)).resolves.toBeUndefined();
        expectApproved(opts, nodeId);
      } finally {
        approval.mockRestore();
        registry.unregister(client.connId);
      }
    },
  );
});

describe("nodeHandlers node.pair.remove", () => {
  it("clears and invalidates wake state when removing a disconnected device-backed node", async () => {
    const { nodeId } = await createNodeState("disconnected-ios-node");
    await registerApns(nodeId);
    await seedNodeWakeState(nodeId);
    enqueueNodePendingWork({ nodeId, type: "location.request" });
    const wakeLifecycle = captureNodeWakeLifecycle(nodeId);

    const { opts } = createOptions({ nodeId });
    await invokeNode("node.pair.remove", opts);
    await Promise.resolve();

    expectSuccess(opts, { nodeId });
    expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork(nodeId).items.map((item) => item.id)).toEqual(["baseline-status"]);
    await expect(loadApnsRegistration(nodeId)).resolves.toBeNull();
  });

  it.each(["success", "failure"])(
    "completes node-role teardown after worker cleanup %s",
    async (cleanup) => {
      const { stateDir, nodeId } = await createNodeState("worker-node-remove");
      await seedNodeWakeState(nodeId);
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId);
      const { opts } = createOptions({ nodeId });
      const order: string[] = [];
      const workerEnvironmentService = {};
      bindDeviceWorkerReconciliation(workerEnvironmentService, async () => {
        order.push("environment");
        if (cleanup === "failure") {
          throw new Error("worker credential write failed");
        }
        return ["environment-1"];
      });
      const reconcileActive = vi.fn(async () => {
        order.push("placement");
      });
      Object.assign(opts.context, {
        workerEnvironmentService,
        workerPlacementDispatchService: { reconcileActive },
      });
      vi.mocked(opts.respond).mockImplementation(() => {
        order.push("respond");
      });

      await invokeNode("node.pair.remove", opts);

      expect(wakeLifecycle.aborted).toBe(true);
      expect(opts.context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
      });
      await expect(getPairedDevice(nodeId, stateDir)).resolves.toBeNull();
      if (cleanup === "failure") {
        expect(reconcileActive).not.toHaveBeenCalled();
        expect(order).toEqual(["environment", "respond"]);
        expect(opts.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("worker credential write failed"),
          }),
        );
      } else {
        expect(reconcileActive).toHaveBeenCalledWith("environment-1");
        expect(order).toEqual(["environment", "placement", "respond"]);
        expectSuccess(opts, { nodeId });
      }
    },
  );

  it("preserves an APNs registration created after node-role removal commits", async () => {
    const { stateDir, nodeId } = await createNodeState("ios-node-registration-race");
    await registerApns(nodeId);

    const { context, opts } = createOptions({ nodeId });
    let replacementWrite: Promise<unknown> | undefined;
    context.invalidateClientsForDevice.mockImplementation(() => {
      replacementWrite = (async () => {
        await pairAndroidNodeDevice(stateDir, nodeId);
        await approveNodeSurface(stateDir, nodeId);
        const replacementGeneration = expectDefined(
          await captureNodePairingGeneration(nodeId),
          "replacement pairing generation",
        );
        return await registerApns(nodeId, {
          token: "DCBA4321DCBA4321DCBA4321DCBA4321",
          expectedPairingGeneration: replacementGeneration.key,
        });
      })();
    });

    await invokeNode("node.pair.remove", opts);
    await replacementWrite;

    await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
      nodeId,
      transport: "direct",
      token: "dcba4321dcba4321dcba4321dcba4321",
    });
  });

  it("removes paired device rows with an approved node surface", async () => {
    const { stateDir, nodeId } = await createNodeState("android-node-1", { surface: true });

    await expect(getPairedDevice(nodeId, stateDir)).resolves.not.toBeNull();

    const { context, opts } = createOptions({ nodeId: ` ${nodeId} ` });
    const captured = captureSecurityEvents();
    const respond = vi.mocked(opts.respond);
    respond.mockImplementation(() => {
      expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
        reason: "device-pair-removed",
      });
      expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    });

    try {
      await invokeNode("node.pair.remove", opts);
      await Promise.resolve();
    } finally {
      captured.stop();
    }

    expect(respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    await expect(getPairedDevice(nodeId, stateDir)).resolves.toBeNull();
    expectDisconnected(context, nodeId);
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(nodeId, {
      caps: [],
      commands: [],
      permissions: undefined,
    });
    expect(context.broadcast).toHaveBeenCalledWith(
      "node.pair.resolved",
      expect.objectContaining({
        decision: "removed",
        nodeId,
        requestId: "",
      }),
      { dropIfSlow: true },
    );
    expect(captured.events).toMatchObject([
      {
        type: "security.event",
        category: "auth",
        action: "device.role.removed",
        outcome: "success",
        severity: "medium",
        target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
        policy: { id: "gateway.device-pairing", decision: "allow" },
        control: { id: "node.pair.remove", family: "auth" },
        attributes: { role: "node", removed_device: true },
      },
    ]);
    expect(JSON.stringify(captured.events)).not.toContain(nodeId);
  });

  it("preserves non-node roles when shared-auth pairing scope removes a mixed-role node", async () => {
    const { stateDir, nodeId } = await createNodeState("mixed-role-android-node-1", {
      role: "operator",
    });
    await registerApns(nodeId);

    const before = await getPairedDevice(nodeId, stateDir);
    expect(before?.roles).toEqual(["operator", "node"]);

    const { context, opts } = createOptions(
      { nodeId },
      {
        client: createClient(["operator.pairing"]),
      },
    );

    await invokeNode("node.pair.remove", opts);
    await Promise.resolve();

    expectSuccess(opts, { nodeId });
    const after = await getPairedDevice(nodeId, stateDir);
    expect(after?.roles).toEqual(["operator"]);
    expect(Object.hasOwn(after?.tokens ?? {}, "operator")).toBe(true);
    expect(Object.hasOwn(after?.tokens ?? {}, "node")).toBe(false);
    await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
      nodeId,
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
    });
    expectDisconnected(context, nodeId);
  });

  it("rejects mixed-role device-backed node removal from non-admin device-token self-service callers", async () => {
    const { stateDir, nodeId } = await createNodeState("device-token-mixed-role-android-node-1", {
      role: "operator",
    });

    const { context, opts } = createOptions(
      { nodeId },
      { client: createClient(["operator.pairing"], nodeId, { isDeviceTokenAuth: true }) },
    );
    const captured = captureSecurityEvents();

    try {
      await invokeNode("node.pair.remove", opts);
    } finally {
      captured.stop();
    }

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node pairing removal denied" }),
    );
    await expect(getPairedDevice(nodeId, stateDir)).resolves.not.toBeNull();
    expect(context.invalidateClientsForDevice).not.toHaveBeenCalled();
    expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(captured.events).toMatchObject([
      {
        action: "device.role.removal_denied",
        outcome: "denied",
        severity: "medium",
        policy: {
          id: "gateway.device-pairing",
          decision: "deny",
          reason: "role-management-requires-admin",
        },
        control: { id: "node.pair.remove", family: "auth" },
        attributes: { role: "node" },
      },
    ]);
  });
});
