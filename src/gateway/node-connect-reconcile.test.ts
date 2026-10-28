import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { NodePairingRequestInput, PairedDeviceNode } from "../infra/device-pairing-node.js";
import { resolveNodePairApprovalScopes } from "../infra/node-pairing-authz.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { resolveEffectiveComputerUseDescriptor } from "./node-computer-use-descriptor.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";

const nodeConnectLog = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "gateway/node-connect" ? { ...logger, ...nodeConnectLog } : logger;
    },
  };
});

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

it("keeps first-time pending node surfaces declared but not effective", async () => {
  const { result } = await reconcilePending("req-pending", {
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
  expect(result.pendingPairing?.request).toMatchObject({
    caps: ["talk"],
    commands: ["system.run"],
    permissions: { camera: true },
  });
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
  const { result: upgrade } = await reconcilePending("req-windows", {
    connectParams,
    pairedNode: makePairedNode({ caps: ["system"], commands: previouslyApprovedCommands }),
  });
  expect(upgrade.declaredCommands).toEqual(commands);
  expect(upgrade.effectiveCommands).toEqual(previouslyApprovedCommands);
  expect(upgrade.pendingPairing?.request.commands).toEqual(commands);
  const approvedPairingRequest = vi.fn();
  const approvedReconnect = await reconcile({
    connectParams,
    pairedNode: makePairedNode({ caps: ["system"], commands }),
    requestPairing: approvedPairingRequest,
  });
  expect(approvedReconnect.effectiveCommands).toEqual(commands);
  expect(approvedPairingRequest).not.toHaveBeenCalled();
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
  const { result } = await reconcilePending("req-computer", {
    connectParams: desktopConnectParams(),
    pairedNode: makePairedNode({
      caps: ["screen"],
      commands: ["screen.snapshot"],
    }),
  });
  expect(result.effectiveCommands).toEqual(["screen.snapshot"]);
  expect(result.declaredComputerUse).toEqual(computerUseDescriptor());
  expect(effectiveDesktop(result)).toBeUndefined();
  expect(result.pendingPairing?.request.requestId).toBe("req-computer");
  expect(result.pendingPairing?.request.commands).toEqual(["screen.snapshot", "computer.act"]);
  const approved = await reconcile({
    connectParams: desktopConnectParams(),
    pairedNode: makePairedNode({
      caps: ["screen", "computer"],
      commands: ["screen.snapshot", "computer.act"],
    }),
    requestPairing: vi.fn(),
  });
  expect(effectiveDesktop(approved)).toEqual(computerUseDescriptor());
});

it.each([
  ["conflicts with device family", { deviceFamily: "iPhone" }],
  ["omits device family", {}],
])("filters host commands when canonical platform %s", async (_label, clientExtra) => {
  const { result } = await reconcilePending("req-mismatch", {
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
});

it("keeps the approved surface when paired-node reapproval is throttled", async () => {
  const requestPairing = vi.fn(async () => null);

  const result = await reconcile({
    ...cameraUpgrade(),
    requestPairing,
  });

  expect(result.effectiveCaps).toEqual(["camera"]);
  expect(result.effectiveCommands).toEqual([]);
  expect(result.declaredCaps).toEqual(["camera", "screen"]);
  expect(result.pendingPairing).toBeUndefined();
  expect(result.shouldClearPendingPairings).toBeUndefined();
});

it("requires a fresh pairing request when paired node permissions widen", async () => {
  const { result } = await reconcilePending("req-permissions", {
    connectParams: makeNodeConnectParams({
      commands: [],
      permissions: { camera: true, notifications: true },
    }),
    pairedNode: makePairedNode({
      commands: [],
      permissions: { camera: true, notifications: false },
    }),
  });

  expect(result.effectiveCommands).toEqual([]);
  expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
  expect(result.pendingPairing?.request.permissions).toEqual({ camera: true, notifications: true });
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

describe("reconcileNodePairingOnConnect withheld command logging", () => {
  // The logging memory is process-wide, so each case uses its own device id.
  async function connectDevice(params: {
    deviceId: string;
    commands: string[];
    allow?: string[];
  }): Promise<string[]> {
    const result = await reconcileNodePairingOnConnect({
      cfg: {
        gateway: { nodes: { commands: { allow: params.allow ?? [] } } },
      } as never,
      connectParams: makeNodeConnectParams({
        device: {
          id: params.deviceId,
          publicKey: "public-key",
          signature: "signature",
          signedAt: 1,
          nonce: "nonce",
        },
        commands: params.commands,
      }),
      pairedNode: makePairedNode({ nodeId: params.deviceId }),
      requestPairing: vi.fn(async () => null),
    });
    return result.withheldCommands;
  }

  function withheldLogs(level: "warn" | "debug", deviceId: string): unknown[][] {
    return nodeConnectLog[level].mock.calls.filter(([message]) =>
      String(message).startsWith(`node command surface withheld node=${deviceId} `),
    );
  }

  beforeEach(() => {
    nodeConnectLog.warn.mockClear();
    nodeConnectLog.debug.mockClear();
  });

  it("warns once and demotes identical reconnects to debug", async () => {
    const commands = ["ollama.chat", "ollama.models"];

    expect(await connectDevice({ deviceId: "device-repeat", commands })).toEqual([
      "ollama.chat",
      "ollama.models",
    ]);
    await connectDevice({ deviceId: "device-repeat", commands });
    await connectDevice({
      deviceId: "device-repeat",
      commands: ["ollama.models", "ollama.chat"],
    });

    expect(withheldLogs("warn", "device-repeat")).toEqual([
      ["node command surface withheld node=device-repeat commands=ollama.chat,ollama.models"],
    ]);
    expect(withheldLogs("debug", "device-repeat")).toEqual([
      ["node command surface withheld node=device-repeat commands=ollama.chat,ollama.models"],
      ["node command surface withheld node=device-repeat commands=ollama.models,ollama.chat"],
    ]);
  });

  it("warns again when gateway policy changes the withheld set", async () => {
    const commands = ["ollama.chat", "ollama.models"];

    await connectDevice({ deviceId: "device-policy", commands });
    expect(
      await connectDevice({ deviceId: "device-policy", commands, allow: ["ollama.chat"] }),
    ).toEqual(["ollama.models"]);
    await connectDevice({ deviceId: "device-policy", commands, allow: ["ollama.chat"] });

    expect(withheldLogs("warn", "device-policy")).toEqual([
      ["node command surface withheld node=device-policy commands=ollama.chat,ollama.models"],
      ["node command surface withheld node=device-policy commands=ollama.models"],
    ]);
    expect(withheldLogs("debug", "device-policy")).toHaveLength(1);
  });

  it("warns again when withholding returns after a clear connect", async () => {
    const commands = ["ollama.chat"];

    await connectDevice({ deviceId: "device-cleared", commands });
    expect(
      await connectDevice({ deviceId: "device-cleared", commands, allow: ["ollama.chat"] }),
    ).toEqual([]);
    await connectDevice({ deviceId: "device-cleared", commands });

    expect(withheldLogs("warn", "device-cleared")).toHaveLength(2);
    expect(withheldLogs("debug", "device-cleared")).toEqual([]);
  });

  it.each(["close", "restart"] as const)(
    "warns on the first identical reconnect after Gateway %s",
    async (event) => {
      const deviceId = `device-lifecycle-${event}`;
      const commands = ["ollama.chat", "ollama.models"];

      await connectDevice({ deviceId, commands });
      await drainGlobalSingletonLifecycleState(event);
      expect(await connectDevice({ deviceId, commands })).toEqual(commands);

      expect(withheldLogs("warn", deviceId)).toHaveLength(2);
      expect(withheldLogs("debug", deviceId)).toEqual([]);
    },
  );

  it("tracks each node's withheld set separately", async () => {
    const commands = ["ollama.chat"];

    await connectDevice({ deviceId: "device-a", commands });
    await connectDevice({ deviceId: "device-b", commands });
    await connectDevice({ deviceId: "device-a", commands });

    expect(withheldLogs("warn", "device-a")).toHaveLength(1);
    expect(withheldLogs("warn", "device-b")).toHaveLength(1);
    expect(withheldLogs("debug", "device-a")).toHaveLength(1);
  });
});
