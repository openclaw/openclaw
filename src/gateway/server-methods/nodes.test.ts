import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveDevicePairing, requestDevicePairing } from "../../infra/device-pairing.js";
import { approveNodePairing, requestNodePairing } from "../../infra/node-pairing.js";
import { resolvePairingPaths } from "../../infra/pairing-files.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { nodeHandlers } from "./nodes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const createdStates: OpenClawTestState[] = [];

async function createState(label: string): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({ label, layout: "state-only" });
  createdStates.push(state);
  return state;
}

afterEach(async () => {
  vi.clearAllMocks();
  while (createdStates.length > 0) {
    await createdStates.pop()?.cleanup();
  }
});

function createContext() {
  return {
    broadcast: vi.fn(),
    disconnectClientsForDevice: vi.fn(),
    invalidateClientsForDevice: vi.fn(),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    nodeRegistry: {
      listConnected: vi.fn(() => []),
      updateSurface: vi.fn(),
    },
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
} {
  const context = createContext();
  const opts = {
    req: { type: "req", id: "req-1", method: "node.pair.remove", params },
    params,
    client: createClient(["operator.pairing", "operator.admin"]),
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context,
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
  return { context, opts };
}

async function pairAndroidNodeDevice(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: [] },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}

async function pairMixedRoleAndroidDevice(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `public-key-${nodeId}`,
      displayName: "Galaxy A54 5G",
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      role: "operator",
      roles: ["operator", "node"],
      scopes: ["operator.pairing"],
    },
    stateDir,
  );
  const approved = await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing"] },
    stateDir,
  );
  expect(approved?.status).toBe("approved");
}

async function pairLegacyNode(stateDir: string, nodeId: string): Promise<void> {
  const pending = await requestNodePairing(
    {
      nodeId,
      platform: "android",
      deviceFamily: "Android",
      clientId: "openclaw-android",
      clientMode: "node",
      displayName: "Galaxy A54 5G",
    },
    stateDir,
  );
  const approved = await approveNodePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing"] },
    stateDir,
  );
  expect(approved).toEqual(expect.objectContaining({ node: expect.objectContaining({ nodeId }) }));
}

async function readPaired(
  stateDir: string,
  subdir: "devices" | "nodes",
): Promise<Record<string, unknown>> {
  const { pairedPath } = resolvePairingPaths(stateDir, subdir);
  return JSON.parse(await readFile(pairedPath, "utf8")) as Record<string, unknown>;
}

describe("nodeHandlers node.pair.remove", () => {
  it("removes Android device-backed node rows from devices paired.json", async () => {
    const state = await createState("node-remove-android-device-backed");
    const nodeId = "android-node-1";
    await pairAndroidNodeDevice(state.stateDir, nodeId);

    expect(Object.hasOwn(await readPaired(state.stateDir, "devices"), nodeId)).toBe(true);

    const { context, opts } = createOptions({ nodeId: ` ${nodeId} ` });
    const respond = vi.mocked(opts.respond);
    respond.mockImplementation(() => {
      expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
        reason: "device-pair-removed",
      });
      expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    });

    await nodeHandlers["node.pair.remove"](opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    expect(Object.hasOwn(await readPaired(state.stateDir, "devices"), nodeId)).toBe(false);
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
  });

  it("removes both backing records when a node row is merged from node and device stores", async () => {
    const state = await createState("node-remove-merged-backing-stores");
    const nodeId = "merged-android-node-1";
    await pairLegacyNode(state.stateDir, nodeId);
    await pairAndroidNodeDevice(state.stateDir, nodeId);

    expect(Object.hasOwn(await readPaired(state.stateDir, "nodes"), nodeId)).toBe(true);
    expect(Object.hasOwn(await readPaired(state.stateDir, "devices"), nodeId)).toBe(true);

    const { context, opts } = createOptions({ nodeId: ` ${nodeId} ` });
    const respond = vi.mocked(opts.respond);
    respond.mockImplementation(() => {
      expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
        role: "node",
        reason: "device-pair-removed",
      });
      expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
    });

    await nodeHandlers["node.pair.remove"](opts);
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    expect(Object.hasOwn(await readPaired(state.stateDir, "nodes"), nodeId)).toBe(false);
    expect(Object.hasOwn(await readPaired(state.stateDir, "devices"), nodeId)).toBe(false);
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
  });

  it("preserves non-node device roles when removing a mixed-role node row", async () => {
    const state = await createState("node-remove-mixed-role-device");
    const nodeId = "mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);

    const before = await readPaired(state.stateDir, "devices");
    expect(
      (before[nodeId] as { roles?: string[]; tokens?: Record<string, unknown> }).roles,
    ).toEqual(["operator", "node"]);

    const { context, opts } = createOptions({ nodeId });

    await nodeHandlers["node.pair.remove"](opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    const after = await readPaired(state.stateDir, "devices");
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
    expect(context.invalidateClientsForDevice).toHaveBeenCalledWith(nodeId, {
      role: "node",
      reason: "device-pair-removed",
    });
    expect(context.disconnectClientsForDevice).toHaveBeenCalledWith(nodeId, { role: "node" });
  });

  it("removes mixed-role device-backed node rows for shared-auth operator.pairing without admin", async () => {
    // Aligns with device.pair.remove: shared-auth / CLI operators that hold
    // operator.pairing (but not operator.admin) manage pairings on others'
    // behalf and must be able to remove the node role from a mixed-role row.
    const state = await createState("node-remove-mixed-role-shared-auth");
    const nodeId = "shared-auth-mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);

    const before = await readPaired(state.stateDir, "devices");
    expect((before[nodeId] as { roles?: string[] }).roles).toEqual(["operator", "node"]);

    const { context, opts } = createOptions(
      { nodeId },
      { client: createClient(["operator.pairing"]) },
    );

    await nodeHandlers["node.pair.remove"](opts);
    await Promise.resolve();

    expect(opts.respond).toHaveBeenCalledWith(true, { nodeId }, undefined);
    const after = await readPaired(state.stateDir, "devices");
    expect((after[nodeId] as { roles?: string[] }).roles).toEqual(["operator"]);
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
    const state = await createState("node-remove-mixed-role-device-token");
    const nodeId = "device-token-mixed-role-android-node-1";
    await pairMixedRoleAndroidDevice(state.stateDir, nodeId);

    const { context, opts } = createOptions(
      { nodeId },
      { client: createClient(["operator.pairing"], nodeId, { isDeviceTokenAuth: true }) },
    );

    await nodeHandlers["node.pair.remove"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "node pairing removal denied" }),
    );
    expect(Object.hasOwn(await readPaired(state.stateDir, "devices"), nodeId)).toBe(true);
    expect(context.invalidateClientsForDevice).not.toHaveBeenCalled();
    expect(context.disconnectClientsForDevice).not.toHaveBeenCalled();
  });
});
