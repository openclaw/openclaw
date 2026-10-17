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
  listDevicePairing,
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
import {
  captureNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "../node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
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

function registerApns(nodeId: string) {
  return registerApnsRegistration({
    nodeId,
    transport: "direct",
    token: "ABCD1234ABCD1234ABCD1234ABCD1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
  });
}

async function seedNodeWakeState(nodeId: string): Promise<void> {
  await runNodeWakeAttempt({
    nodeId,
    force: true,
    throttleMs: 60_000,
    attempt: async (markAttempted) => {
      markAttempted();
      return { available: true, throttled: false, path: "sent", durationMs: 1 };
    },
  });
  await runNodeWakeNudgeAttempt({
    nodeId,
    throttleMs: 60_000,
    throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
    attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
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

function captureSecurityEvents(): {
  events: Extract<DiagnosticEventPayload, { type: "security.event" }>[];
  stop: () => void;
} {
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
): {
  context: ReturnType<typeof createContext>;
  opts: GatewayRequestHandlerOptions;
  respond: ReturnType<typeof vi.fn>;
} {
  const context = createContext();
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

describe("nodeHandlers node.skills.update", () => {
  it("stores and publishes a validated replacement catalog for the calling node", async () => {
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
      displayName: "Build Mac",
      nodeSkills: [skill],
    });

    await invokeNode("node.skills.update", opts);

    expect(context.nodeRegistry.updateNodeSkills).toHaveBeenCalledWith("node-1", "conn-1", [skill]);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { nodeId: "node-1", skills: [skill] },
      undefined,
    );
  });
});

function expectApproved(opts: GatewayRequestHandlerOptions, nodeId: string) {
  expect(opts.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ node: expect.objectContaining({ nodeId }) }),
    undefined,
  );
}

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
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
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
  return nodePairing.requestNodePairing(
    {
      nodeId,
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      displayName,
    },
    stateDir,
  );
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

describe("nodeHandlers node.describe", () => {
  it("projects exact runner slots with derived launch eligibility", async () => {
    const { nodeId } = await createNodeState("node-1", { surface: true });
    const pairingState = await captureNodePairingState(nodeId);
    expect(pairingState?.generation).not.toBeNull();

    const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
    const nodeClient = createWorkerSupervisorNodeClient("conn-1");
    runtime.nodeRegistry.register(nodeClient, {
      pairingIdentity: pairingState?.identity.key ?? "",
      pairingGeneration: pairingState?.generation?.key,
    });
    const publication = createOptions(
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 2, available: 2 },
          bundleRetention: 1,
          bundleStatus: 1,
        },
      },
      { client: nodeClient as never },
    );
    Object.assign(publication.context, { nodeRegistry: runtime.nodeRegistry });
    await invokeNode("node.runnerInventory.update", publication.opts);
    const [proof] = await runtime.nodeWorkerSupervisorTransport.listCurrentNodes();
    expect(proof).toBeDefined();
    expect(
      proof &&
        runtime.nodeWorkerSupervisorTransport.acceptBundleStatus?.(proof, {
          bundleHash: "a".repeat(64),
          status: { status: "installed", version: "2026.8.9" },
        }),
    ).toBe(true);

    const listCall = createOptions({});
    Object.assign(listCall.context, { nodeRegistry: runtime.nodeRegistry });
    await invokeNode("node.list", listCall.opts);
    const describeCall = createOptions({ nodeId });
    Object.assign(describeCall.context, { nodeRegistry: runtime.nodeRegistry });
    await invokeNode("node.describe", describeCall.opts);

    expect(listCall.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId,
            workerSlots: { total: 2, available: 2 },
            workerBundle: { status: "installed", version: "2026.8.9" },
          }),
        ]),
      }),
      undefined,
    );
    expect(describeCall.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        nodeId,
        sessionHost: true,
        workerSlots: { total: 2, available: 2 },
        workerBundle: { status: "installed", version: "2026.8.9" },
      }),
      undefined,
    );
    expect(JSON.stringify(listCall.respond.mock.calls)).not.toContain("bundleHash");
    expect(JSON.stringify(describeCall.respond.mock.calls)).not.toContain("bundleHash");
    runtime.nodeRegistry.unregister(nodeClient.connId);
  });
});

async function readPaired(stateDir: string): Promise<Record<string, unknown>> {
  const { paired } = await listDevicePairing(stateDir);
  return Object.fromEntries(paired.map((device) => [device.deviceId, device]));
}

describe("nodeHandlers node.pair.approve", () => {
  it("promotes the first surface only for the same authenticated pairing identity", async () => {
    const { stateDir, nodeId } = await createNodeState("node-pending-identity-stable");
    const pending = await requestSurface(stateDir, nodeId, "Galaxy A54 5G pending");
    const pendingState = await captureNodePairingState(nodeId);
    expect(pendingState?.generation).toBeNull();

    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    context.nodeRegistry.get.mockReturnValue({
      nodeId,
      connId: "conn-pending-identity-stable",
      pairingIdentity: pendingState?.identity.key,
    });

    await invokeNode("node.pair.approve", opts);

    const approvedState = await captureNodePairingState(nodeId);
    expect(approvedState?.identity.key).toBe(pendingState?.identity.key);
    expect(approvedState?.generation).not.toBeNull();
    expect(context.nodeRegistry.updateSurface).toHaveBeenCalledWith(
      nodeId,
      expect.objectContaining({ commands: expect.any(Array) }),
      {
        expectedConnId: "conn-pending-identity-stable",
        expectedPairingIdentity: pendingState?.identity.key,
        nextPairingGeneration: approvedState?.generation?.key,
      },
    );
    expectApproved(opts, nodeId);
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
    const publication = createOptions(
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      },
      { client: client as never },
    );
    Object.assign(publication.context, { nodeRegistry: runtime.nodeRegistry });
    await invokeNode("node.runnerInventory.update", publication.opts);
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
    const approval = createOptions({ requestId: pending.request.requestId });
    Object.assign(approval.context, { nodeRegistry: runtime.nodeRegistry });
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
    const republish = createOptions(
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
      },
      { client: client as never },
    );
    Object.assign(republish.context, { nodeRegistry: runtime.nodeRegistry });
    await invokeNode("node.runnerInventory.update", republish.opts);

    await expect(runtime.nodeWorkerSupervisorTransport.listCurrentNodes()).resolves.toEqual([
      expect.objectContaining({
        connId: "conn-surface-reapproval",
        pairingGeneration: nextGeneration?.key,
      }),
    ]);
    runtime.nodeRegistry.unregister("conn-surface-reapproval");
  });

  it.each(["before approval", "after surface commit"])(
    "does not deliver approval to the old session when device reapproval wins %s",
    async (timing) => {
      const { stateDir, nodeId } = await createNodeState("node-reapproval-race", { surface: true });
      const staleState = expectDefined(await captureNodePairingState(nodeId), "paired node");
      const staleGeneration = expectDefined(staleState.generation, "approved surface");
      const pending = await requestSurface(stateDir, nodeId, "Galaxy A54 5G reapproved");
      const registry = new NodeRegistry({
        resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
        isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
      });
      const client = createWorkerSupervisorNodeClient("conn-before-reapproval");
      const send = vi.spyOn(client.socket, "send");
      client.connect.device = { ...client.connect.device!, id: nodeId };
      registry.register(client, {
        pairingIdentity: staleState.identity.key,
        pairingGeneration: staleGeneration.key,
      });
      const approve = nodePairing.approveNodePairing;
      const approval = vi.spyOn(nodePairing, "approveNodePairing");
      if (timing === "before approval") {
        await pairAndroidNodeDevice(stateDir, nodeId);
        expect((await captureNodePairingGeneration(nodeId))?.key).not.toBe(staleGeneration.key);
      } else {
        approval.mockImplementation(async (...args) => {
          const result = await approve(...args);
          await pairAndroidNodeDevice(stateDir, nodeId);
          return result;
        });
      }
      const { context, opts } = createOptions({ requestId: pending.request.requestId });
      Object.assign(context, { nodeRegistry: registry });
      try {
        await invokeNode("node.pair.approve", opts);
        expect((await captureNodePairingGeneration(nodeId))?.key).not.toBe(staleGeneration.key);
        expect(send).not.toHaveBeenCalled();
        await expect(registry.getCurrentConnected(nodeId)).resolves.toBeUndefined();
        expectApproved(opts, nodeId);
      } finally {
        approval.mockRestore();
        registry.unregister(client.connId);
      }
    },
  );

  it("does not promote a generation-less session after external node-token rotation", async () => {
    const { stateDir, nodeId } = await createNodeState("node-pending-identity-rotation");
    const pending = await requestSurface(stateDir, nodeId, "Galaxy A54 5G pending");
    const staleState = await captureNodePairingState(nodeId);
    expect(staleState?.generation).toBeNull();

    const rotated = await rotateDeviceToken({
      deviceId: nodeId,
      role: "node",
      scopes: [],
      baseDir: stateDir,
    });
    expect(rotated.ok).toBe(true);
    const currentState = await captureNodePairingState(nodeId);
    expect(currentState?.generation).toBeNull();
    expect(currentState?.identity.key).not.toBe(staleState?.identity.key);

    const registry = new NodeRegistry({
      resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
      isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
    });
    const client = createWorkerSupervisorNodeClient("conn-authenticated-before-token-rotation");
    const send = vi.spyOn(client.socket, "send");
    client.connect.device = { ...client.connect.device!, id: nodeId };
    registry.register(client, { pairingIdentity: staleState?.identity.key ?? "" });
    const { context, opts } = createOptions({ requestId: pending.request.requestId });
    Object.assign(context, { nodeRegistry: registry });

    try {
      await invokeNode("node.pair.approve", opts);
      expect(send).not.toHaveBeenCalled();
      await expect(registry.getCurrentConnected(nodeId)).resolves.toBeUndefined();
      expectApproved(opts, nodeId);
    } finally {
      registry.unregister(client.connId);
    }
  });
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

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
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
      expect(Object.hasOwn(await readPaired(stateDir), nodeId)).toBe(false);
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
        expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
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
        const replacementGeneration = await captureNodePairingGeneration(nodeId);
        if (!replacementGeneration) {
          throw new Error("expected replacement pairing generation");
        }
        return await registerApnsRegistration({
          nodeId,
          transport: "direct",
          token: "DCBA4321DCBA4321DCBA4321DCBA4321",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
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

    expect(Object.hasOwn(await readPaired(stateDir), nodeId)).toBe(true);

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
    expect(Object.hasOwn(await readPaired(stateDir), nodeId)).toBe(false);
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
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
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: "security.event",
      category: "auth",
      action: "device.role.removed",
      outcome: "success",
      severity: "medium",
      target: { kind: "device", idHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/u) },
      policy: { id: "gateway.device-pairing", decision: "allow" },
      control: { id: "node.pair.remove", family: "auth" },
      attributes: { role: "node", removed_device: true },
    });
    expect(JSON.stringify(captured.events)).not.toContain(nodeId);
  });

  it("preserves non-node roles when shared-auth pairing scope removes a mixed-role node", async () => {
    const { stateDir, nodeId } = await createNodeState("mixed-role-android-node-1", {
      role: "operator",
    });
    await registerApns(nodeId);

    const before = await readPaired(stateDir);
    expect(
      (before[nodeId] as { roles?: string[]; tokens?: Record<string, unknown> }).roles,
    ).toEqual(["operator", "node"]);

    const { context, opts } = createOptions(
      { nodeId },
      {
        client: createClient(["operator.pairing"]),
      },
    );

    await invokeNode("node.pair.remove", opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    const after = await readPaired(stateDir);
    expect((after[nodeId] as { roles?: string[]; tokens?: Record<string, unknown> }).roles).toEqual(
      ["operator"],
    );
    expect(
      Object.hasOwn(
        (after[nodeId] as { tokens?: Record<string, unknown> }).tokens ?? {},
        "operator",
      ),
    ).toBe(true);
    expect(
      Object.hasOwn((after[nodeId] as { tokens?: Record<string, unknown> }).tokens ?? {}, "node"),
    ).toBe(false);
    await expect(loadApnsRegistration(nodeId)).resolves.toMatchObject({
      nodeId,
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
    });
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
  });

  it("rejects mixed-role device-backed node removal from non-admin device-token self-service callers", async () => {
    // Mirror device.pair.remove: a device-token self-service caller (proves
    // ownership of its own device id, no operator.admin) cannot remove the node
    // role from a mixed-role row it owns.
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
    expect(Object.hasOwn(await readPaired(stateDir), nodeId)).toBe(true);
    expect(context.invalidateClientsForDevice).not.toHaveBeenCalled();
    expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
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
    });
  });
});
