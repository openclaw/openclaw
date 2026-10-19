import { afterEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { NodePairingRequestInput, PairedDeviceNode } from "../infra/device-pairing-node.js";
import { resolveNodePairApprovalScopes } from "../infra/node-pairing-authz.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../plugins/computer-use-registration.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveEffectiveComputerUseDescriptor } from "./node-computer-use-descriptor.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";

const makeNodeConnectParams = (overrides?: Partial<ConnectParams>): ConnectParams => ({
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: "openclaw-ios",
    version: "test",
    platform: "ios",
    mode: "node",
  },
  commands: ["canvas.snapshot"],
  ...overrides,
});

const hostConnectParams = (overrides: Partial<ConnectParams> = {}, platform = "macos") =>
  makeNodeConnectParams({
    client: {
      id: GATEWAY_CLIENT_IDS.NODE_HOST,
      version: "test",
      platform,
      deviceFamily: platform === "macos" ? "Mac" : "Windows",
      mode: GATEWAY_CLIENT_MODES.NODE,
    },
    ...overrides,
  });

const desktopConnectParams = () =>
  hostConnectParams({
    caps: ["screen", "computer"],
    commands: ["screen.snapshot", "computer.act"],
    computerUse: computerUseDescriptor(),
  });

type ReconcileInput = Parameters<typeof reconcileNodePairingOnConnect>[0];
const reconcile = (overrides: Pick<ReconcileInput, "requestPairing"> & Partial<ReconcileInput>) =>
  reconcileNodePairingOnConnect({
    cfg: {},
    connectParams: makeNodeConnectParams(),
    pairedNode: null,
    ...overrides,
  });

const cameraUpgrade = () => ({
  connectParams: makeNodeConnectParams({ caps: ["camera", "screen"], commands: [] }),
  pairedNode: makePairedNode({ caps: ["camera"], commands: [] }),
});

const effectiveDesktop = (result: Awaited<ReturnType<typeof reconcile>>) =>
  resolveEffectiveComputerUseDescriptor({
    commands: result.effectiveCommands,
    declared: result.declaredComputerUse,
  });

const makePairedNode = (overrides?: Partial<PairedDeviceNode>): PairedDeviceNode => ({
  nodeId: "openclaw-ios",
  createdAtMs: 1,
  approvedAtMs: 1,
  ...overrides,
});

function makePendingPairingRequest(requestId: string) {
  return vi.fn(async (input: NodePairingRequestInput) => ({
    status: "pending" as const,
    request: {
      ...input,
      requestId,
      requiredApproveScopes: resolveNodePairApprovalScopes(input.commands),
      ts: 1,
    },
    created: true,
  }));
}

async function reconcilePending(
  requestId: string,
  input: Omit<Partial<ReconcileInput>, "requestPairing"> = {},
) {
  const requestPairing = makePendingPairingRequest(requestId);
  return { result: await reconcile({ ...input, requestPairing }), requestPairing };
}

const computerUseDescriptor = (): ComputerUseCapabilityDescriptor => ({
  contractVersion: 2 as const,
  provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
  actions: ["screenshot", "left_click"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
});

afterEach(resetPluginRuntimeStateForTest);

it("marks the first-surface request silent when device pairing was non-interactive", async () => {
  const { requestPairing } = await reconcilePending("req-silent", { initialSurfaceSilent: true });
  expect(requestPairing).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
});

it("keeps surface upgrade requests interactive even when the device paired silently", async () => {
  const { result, requestPairing } = await reconcilePending("req-upgrade-loud", {
    ...cameraUpgrade(),
    initialSurfaceSilent: true,
  });
  expect(requestPairing).toHaveBeenCalledOnce();
  const input = requestPairing.mock.calls[0]?.[0];
  expect(input?.silent).toBeUndefined();
  expect(result.effectiveCaps).toEqual(["camera"]);
  expect(result.declaredCaps).toEqual(["camera", "screen"]);
  expect(result.pendingPairing?.request.requestId).toBe("req-upgrade-loud");
});

it("keeps first-time pending node surfaces declared but not effective", async () => {
  const { result, requestPairing } = await reconcilePending("req-pending", {
    connectParams: hostConnectParams({
      caps: ["talk"],
      commands: ["system.run"],
      permissions: { camera: true },
    }),
  });
  expect(result.declaredCaps).toEqual(["talk"]);
  expect(result.effectiveCaps).toEqual([]);
  expect(result.declaredCommands).toEqual(["system.run"]);
  expect(result.effectiveCommands).toEqual([]);
  expect(result.declaredPermissions).toEqual({ camera: true });
  expect(result.effectivePermissions).toBeUndefined();
  expect(requestPairing).toHaveBeenCalledWith(
    expect.objectContaining({
      caps: ["talk"],
      commands: ["system.run"],
      permissions: { camera: true },
    }),
  );
});

it("reapproves and then preserves Windows exec approval commands", async () => {
  const commands = [
    "system.run.prepare",
    "system.run",
    "system.which",
    "system.execApprovals.get",
    "system.execApprovals.set",
  ];
  const previouslyApprovedCommands = ["system.run.prepare", "system.run", "system.which"];
  const connectParams = hostConnectParams({ caps: ["system"], commands }, "windows");
  const { result: upgrade, requestPairing } = await reconcilePending("req-windows", {
    connectParams,
    pairedNode: makePairedNode({ caps: ["system"], commands: previouslyApprovedCommands }),
  });
  expect(upgrade.declaredCommands).toEqual(commands);
  expect(upgrade.effectiveCommands).toEqual(previouslyApprovedCommands);
  expect(requestPairing).toHaveBeenCalledWith(expect.objectContaining({ commands }));
  const approvedPairingRequest = vi.fn();
  const approvedReconnect = await reconcile({
    connectParams,
    pairedNode: makePairedNode({ caps: ["system"], commands }),
    requestPairing: approvedPairingRequest,
  });
  expect(approvedReconnect.effectiveCommands).toEqual(commands);
  expect(approvedPairingRequest).not.toHaveBeenCalled();
});

it("keeps an approved computer.act surface effective while a computer-use provider plugin is active", async () => {
  // The default macOS Gateway's provider is active while the approved node reconnects.
  const registry = createEmptyPluginRegistry();
  const origin = {
    pluginId: "cua-computer",
    pluginName: "CUA Computer",
    source: "/extensions/cua-computer/index.ts",
    rootDir: "/extensions/cua-computer",
  };
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) => {
        registry.nodeHostCommands.push({ ...origin, command });
      },
    },
    {
      id: "fixture",
      label: "Fixture",
      capabilities: () => computerUseDescriptor(),
      isAvailable: () => true,
      openExecution: () => {
        throw new Error("unused");
      },
    },
  );
  registry.nodeInvokePolicies.push({
    ...origin,
    pluginConfig: {},
    policy: {
      commands: ["computer.act"],
      dangerous: true,
      handle: async (ctx) => await ctx.invokeNode(),
    },
  });
  setActivePluginRegistry(registry);
  const requestPairing = vi.fn();

  const result = await reconcile({
    connectParams: desktopConnectParams(),
    pairedNode: makePairedNode({
      caps: ["screen", "computer"],
      commands: ["screen.snapshot", "computer.act"],
    }),
    requestPairing,
  });
  expect(requestPairing).not.toHaveBeenCalled();
  expect(result.shouldClearPendingPairings).toBe(true);
  expect(result.declaredCommands).toEqual(["screen.snapshot", "computer.act"]);
  expect(result.effectiveCommands).toEqual(["screen.snapshot", "computer.act"]);
  expect(result.declaredCaps).toEqual(["screen", "computer"]);
  expect(result.effectiveCaps).toEqual(["screen", "computer"]);
  expect(effectiveDesktop(result)).toEqual(computerUseDescriptor());
});

it("drops a capability whose declared commands were all filtered by policy", async () => {
  // Denying every command must also remove the advertised capability.
  const { result, requestPairing } = await reconcilePending("req-denied-computer", {
    cfg: {
      gateway: { nodes: { commands: { deny: ["computer.act"] } } },
    },
    connectParams: desktopConnectParams(),
    pairedNode: makePairedNode({
      caps: ["screen", "computer"],
      commands: ["screen.snapshot"],
    }),
  });
  expect(result.declaredCommands).toEqual(["screen.snapshot"]);
  expect(result.declaredCaps).toEqual(["screen"]);
  expect(result.effectiveCaps).toEqual(["screen"]);
  expect(result.withheldCommands).toEqual(["computer.act"]);
  expect(requestPairing).not.toHaveBeenCalled();
});

it("requests pairing when a macOS node first declares computer.act", async () => {
  const { result, requestPairing } = await reconcilePending("req-computer", {
    connectParams: desktopConnectParams(),
    pairedNode: makePairedNode({
      caps: ["screen"],
      commands: ["screen.snapshot"],
    }),
  });
  expect(requestPairing).toHaveBeenCalledWith(
    expect.objectContaining({
      caps: ["screen", "computer"],
      commands: ["screen.snapshot", "computer.act"],
    }),
  );
  expect(result.effectiveCommands).toEqual(["screen.snapshot"]);
  expect(result.declaredComputerUse).toEqual(computerUseDescriptor());
  expect(effectiveDesktop(result)).toBeUndefined();
  expect(result.pendingPairing?.request.requestId).toBe("req-computer");
});

it("keeps registry-bound node plugin tool commands in first-time pairing", async () => {
  const registry = createEmptyPluginRegistry();
  registry.nodeHostCommands = [
    {
      pluginId: "remote",
      pluginName: "Remote",
      source: "/extensions/remote/index.ts",
      rootDir: "/extensions/remote",
      command: {
        command: "remote.echo",
        agentTool: {
          name: "remote_echo",
          description: "Echo from a node host",
          defaultPlatforms: ["macos"],
        },
        handle: async () => "{}",
      },
    },
  ];
  setActivePluginRegistry(registry);
  const { result, requestPairing } = await reconcilePending("req-plugin-tool", {
    connectParams: hostConnectParams({ commands: ["remote.echo"] }),
  });
  expect(result.declaredCommands).toEqual(["remote.echo"]);
  expect(result.effectiveCommands).toEqual([]);
  expect(requestPairing).toHaveBeenCalledWith(
    expect.objectContaining({ commands: ["remote.echo"] }),
  );
});

it.each([
  ["conflicts with device family", { deviceFamily: "iPhone" }],
  ["omits device family", {}],
])("filters host commands when canonical platform %s", async (_label, clientExtra) => {
  const { result, requestPairing } = await reconcilePending("req-mismatch", {
    connectParams: makeNodeConnectParams({
      client: {
        id: "openclaw-ios",
        version: "test",
        platform: "macos",
        mode: "node",
        ...clientExtra,
      },
      commands: ["system.run", "system.which"],
    }),
  });

  expect(result.declaredCommands).toEqual([]);
  expect(requestPairing).toHaveBeenCalledWith(expect.objectContaining({ commands: [] }));
});

it("keeps the approved surface when paired-node reapproval is throttled", async () => {
  const requestPairing = vi.fn(async () => null);

  const result = await reconcile({
    ...cameraUpgrade(),
    requestPairing,
  });

  expect(requestPairing).toHaveBeenCalledOnce();
  expect(result.effectiveCaps).toEqual(["camera"]);
  expect(result.effectiveCommands).toEqual([]);
  expect(result.declaredCaps).toEqual(["camera", "screen"]);
  expect(result.pendingPairing).toBeUndefined();
  expect(result.shouldClearPendingPairings).toBeUndefined();
});

it("requires a fresh pairing request when paired node permissions widen", async () => {
  const { result, requestPairing } = await reconcilePending("req-permissions", {
    connectParams: makeNodeConnectParams({
      commands: [],
      permissions: { camera: true, notifications: true },
    }),
    pairedNode: makePairedNode({
      commands: [],
      permissions: { camera: true, notifications: false },
    }),
  });

  expect(requestPairing).toHaveBeenCalledWith({
    nodeId: "openclaw-ios",
    clientId: undefined,
    clientMode: undefined,
    displayName: undefined,
    platform: "ios",
    version: "test",
    deviceFamily: undefined,
    modelIdentifier: undefined,
    caps: [],
    commands: [],
    permissions: { camera: true, notifications: true },
    remoteIp: undefined,
  });
  expect(result.effectiveCommands).toEqual([]);
  expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
  expect(result.pendingPairing?.request.requestId).toBe("req-permissions");
});

it("applies declared capability and permission downgrades without reapproval", async () => {
  const requestPairing = vi.fn();

  const result = await reconcile({
    connectParams: makeNodeConnectParams({
      caps: ["camera"],
      commands: [],
      permissions: { camera: false, watchReachable: false },
    }),
    pairedNode: makePairedNode({
      caps: ["camera", "screen"],
      commands: [],
      permissions: { camera: true, notifications: true },
    }),
    requestPairing,
  });

  expect(requestPairing).not.toHaveBeenCalled();
  expect(result.effectiveCaps).toEqual(["camera"]);
  expect(result.effectiveCommands).toEqual([]);
  expect(result.effectivePermissions).toEqual({ camera: false, watchReachable: false });
  expect(result.pendingPairing).toBeUndefined();
  expect(result.shouldClearPendingPairings).toBe(true);
});
