import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import { resolveNodePairApprovalScopes } from "../infra/node-pairing-authz.js";
import { createKnownNodeCatalog, listKnownNodes } from "./node-catalog.js";
type CatalogInput = Parameters<typeof createKnownNodeCatalog>[0];
type TestPairedDevice = CatalogInput["pairedDevices"][number];
type TestPairedNode = NonNullable<CatalogInput["pairedNodes"]>[number];
type TestPendingNode = NonNullable<CatalogInput["pendingNodes"]>[number];
type TestConnectedNode = CatalogInput["connectedNodes"][number];
const pairedDevice = (overrides: Partial<TestPairedDevice> = {}): TestPairedDevice => ({
  deviceId: "mac-1",
  publicKey: "public-key",
  displayName: "Mac",
  clientId: "openclaw-macos",
  clientMode: "node",
  role: "node",
  roles: ["node"],
  tokens: {
    node: { token: "current-token", role: "node", scopes: [], createdAtMs: 1 },
  },
  createdAtMs: 1,
  approvedAtMs: 99,
  ...overrides,
});

const pairedNode = (overrides: Partial<TestPairedNode> = {}): TestPairedNode => ({
  nodeId: "mac-1",
  platform: "macos",
  caps: ["camera"],
  commands: ["system.run"],
  createdAtMs: 1,
  approvedAtMs: 100,
  ...overrides,
});

function pendingNode(overrides: Partial<TestPendingNode> = {}): TestPendingNode {
  const commands = overrides.commands ?? ["screen.snapshot", "system.run"];
  return {
    requestId: "request-1",
    nodeId: "mac-1",
    platform: "macos",
    caps: ["camera", "screen"],
    commands,
    requiredApproveScopes: resolveNodePairApprovalScopes(commands),
    permissions: { camera: true, screen: true },
    ts: 200,
    ...overrides,
  };
}

const connectedNode = (overrides: Partial<TestConnectedNode> = {}): TestConnectedNode => ({
  nodeId: "mac-1",
  connId: "conn-1",
  client: {} as never,
  declaredCaps: [],
  caps: [],
  declaredCommands: [],
  commands: [],
  declaredNodePluginTools: [],
  nodePluginTools: [],
  nodeSkills: [],
  connectedAtMs: 1,
  ...overrides,
});

const makeCatalog = (overrides: Partial<CatalogInput> = {}) =>
  createKnownNodeCatalog({
    pairedDevices: [pairedDevice()],
    connectedNodes: [],
    ...overrides,
  });
type NodeInput = Partial<CatalogInput> & {
  device?: Partial<TestPairedDevice>;
  paired?: Partial<TestPairedNode>;
  pending?: Partial<TestPendingNode>;
  live?: Partial<TestConnectedNode>;
};
function catalogNode(input: NodeInput) {
  const { device, paired, pending, live, ...rest } = input;
  return makeCatalog({
    ...(device && { pairedDevices: [pairedDevice(device)] }),
    ...(paired && { pairedNodes: [pairedNode(paired)] }),
    ...(pending && { pendingNodes: [pendingNode(pending)] }),
    ...(live && { connectedNodes: [connectedNode(live)] }),
    ...rest,
  }).get(live?.nodeId ?? pending?.nodeId ?? paired?.nodeId ?? device?.deviceId ?? "mac-1");
}

it("never projects private worker controls from persisted or pending state", () => {
  const node = catalogNode({
    paired: { commands: ["system.run", ...NODE_WORKER_PRIVATE_COMMANDS] },
    pending: { commands: ["screen.snapshot", ...NODE_WORKER_PRIVATE_COMMANDS] },
  });
  expect(node?.commands).toEqual(["system.run"]);
  expect(node?.pendingDeclaredCommands).toEqual(["screen.snapshot"]);
});

it("keeps the operator node name across live metadata and reconnects", () => {
  const namedCatalog = (connId: string, displayName: string, approvedName?: string) =>
    makeCatalog({
      pairedDevices: [pairedDevice({ displayName: "Device Name" })],
      pairedNodes: [pairedNode({ displayName: approvedName })],
      connectedNodes: [connectedNode({ connId, displayName })],
    });
  const connected = namedCatalog("conn-1", "Live Name", "Operator Name");
  expect(listKnownNodes(connected)[0]?.displayName).toBe("Operator Name");
  expect(connected.get("mac-1")?.displayName).toBe("Operator Name");
  const reconnected = namedCatalog("conn-2", "Replacement Live Name", "Operator Name");
  expect(reconnected.get("mac-1")?.displayName).toBe("Operator Name");
  const liveFallback = namedCatalog("conn-3", "Live Fallback");
  expect(liveFallback.get("mac-1")?.displayName).toBe("Live Fallback");
});

it("lets live runner consent override stored session-host history", () => {
  for (const sessionHost of [false, true]) {
    const workerSlots = { total: 2, available: Number(sessionHost) };
    const node = catalogNode({
      paired: { sessionHost: !sessionHost },
      live: {},
      sessionHostNodeIds: new Set(sessionHost ? ["mac-1"] : []),
      workerSlotsByNodeId: new Map([["mac-1", workerSlots]]),
    });
    expect(node).toMatchObject({ connected: true, sessionHost, workerSlots });
  }
});

it("publishes existing-folder consent only for a connected device", () => {
  const input = {
    pairedDevices: [pairedDevice()],
    sessionHostNodeIds: new Set(["mac-1"]),
    deviceFolderNodeIds: new Set(["mac-1"]),
  };
  expect(
    createKnownNodeCatalog({ ...input, connectedNodes: [connectedNode()] }).get("mac-1"),
  ).toMatchObject({ workerHost: { deviceFolders: true } });
  expect(
    createKnownNodeCatalog({ ...input, connectedNodes: [] }).get("mac-1")?.workerHost,
  ).toBeUndefined();
});

it("uses the newest durable last-seen source for offline nodes", () => {
  const node = catalogNode({
    device: {
      deviceId: "ios-1",
      displayName: "iPhone",
      lastSeenAtMs: 300,
      lastSeenReason: "silent_push",
      approvedAtMs: 10,
    },
    paired: {
      nodeId: "ios-1",
      platform: "ios",
      caps: [],
      commands: [],
      sessionHost: true,
      lastConnectedAtMs: 200,
      lastDisconnectedAtMs: 250,
      lastSeenAtMs: 100,
      lastSeenReason: "bg_app_refresh",
      approvedAtMs: 11,
    },
  });
  expect(node).toMatchObject({
    lastConnectedAtMs: 200,
    lastDisconnectedAtMs: 250,
    lastSeenAtMs: 300,
    lastSeenReason: "silent_push",
    sessionHost: true,
  });
  expect(node?.workerSlots).toBeUndefined();
});

it("uses pending request metadata as the final fallback for pending-only nodes", () => {
  const metadata = {
    nodeId: "new-node",
    clientId: "openclaw-linux",
    clientMode: "node",
    displayName: "Pending Node",
    platform: "linux",
    version: "1.2.3",
    coreVersion: "1.2.4",
    uiVersion: "1.2.5",
    deviceFamily: "desktop",
    modelIdentifier: "x86_64",
    remoteIp: "100.0.0.20",
  };
  const node = catalogNode({ pairedDevices: [], pending: metadata });
  expect(node).toMatchObject({
    ...metadata,
    approvalState: "pending-approval",
    pendingRequestId: "request-1",
    caps: [],
    commands: [],
    paired: false,
    connected: false,
  });
  expect(node?.permissions).toBeUndefined();
});

it("preserves pending first approval when a metadata reconnect omits permissions", () => {
  const node = catalogNode({
    device: { deviceId: "new-node" },
    pending: { nodeId: "new-node" },
    live: {
      nodeId: "new-node",
      displayName: "New Node",
      platform: "macos",
      declaredCaps: ["camera", "screen"],
      declaredCommands: ["screen.snapshot", "system.run"],
    },
  });
  expect(node).toMatchObject({
    approvalState: "pending-approval",
    pendingRequestId: "request-1",
    permissions: undefined,
  });
  expect(node?.pendingDeclaredPermissions).toEqual({ camera: true, screen: true });
});

it.each([true, false])(
  "selects pending reapproval only for matching live declarations: %s",
  (widened) => {
    const caps = ["camera", "screen"];
    const commands = ["screen.snapshot", "system.run"];
    const permissions = { camera: true, screen: true };
    const node = catalogNode({
      paired: { commands: ["screen.snapshot"], permissions: { camera: true } },
      pending: {},
      live: {
        displayName: "Mac",
        platform: "macos",
        caps: ["camera"],
        commands: ["screen.snapshot"],
        permissions: { camera: true },
        declaredCaps: widened ? caps : ["camera"],
        declaredCommands: widened ? commands : ["screen.snapshot"],
        declaredPermissions: widened ? permissions : { camera: true },
      },
    });
    expect(node).toMatchObject({
      approvalState: widened ? "pending-reapproval" : "approved",
      pendingRequestId: widened ? "request-1" : undefined,
      pendingDeclaredCaps: widened ? caps : undefined,
      pendingDeclaredCommands: widened ? commands : undefined,
      caps: ["camera"],
      commands: ["screen.snapshot"],
    });
    expect(node?.pendingDeclaredPermissions).toEqual(widened ? permissions : undefined);
    expect(node?.permissions).toEqual({ camera: true });
  },
);

it("ignores malformed node capability entries instead of throwing", () => {
  const catalog = createKnownNodeCatalog({
    pairedDevices: [],
    pairedNodes: [],
    connectedNodes: [
      {
        nodeId: "bad-node",
        connId: "conn-1",
        client: {} as never,
        displayName: "Bad Node",
        caps: ["camera", undefined],
        commands: ["system.run", null],
        connectedAtMs: 1,
      } as never,
    ],
  });
  const nodes = listKnownNodes(catalog);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.nodeId).toBe("bad-node");
  expect(nodes[0]?.caps).toEqual(["camera"]);
  expect(nodes[0]?.commands).toEqual(["system.run"]);
});

it("normalizes non-string scalar fields from malformed pairing records (no nodes-status crash)", () => {
  // Corrupt disk scalars must not reach status formatters' string operations.
  expect(
    catalogNode({
      device: {
        displayName: 654 as unknown as string,
        clientId: 456 as unknown as string,
        clientMode: 789 as unknown as string,
      },
      paired: {
        version: 123 as unknown as string,
        displayName: 321 as unknown as string,
        platform: "linux",
        remoteIp: 22 as unknown as string,
        deviceFamily: 33 as unknown as string,
        modelIdentifier: 44 as unknown as string,
      },
      live: { platform: {} as unknown as string },
    }),
  ).toMatchObject({
    version: undefined,
    displayName: undefined,
    clientId: undefined,
    clientMode: undefined,
    platform: "linux",
    remoteIp: undefined,
    deviceFamily: undefined,
    modelIdentifier: undefined,
  });
});

it("drops blind-cast pairing entries whose required id is not a string", () => {
  const catalog = createKnownNodeCatalog({
    pairedDevices: [
      pairedDevice({ deviceId: "good-node" }),
      // Invalid IDs must not reach listKnownNodes' localeCompare sort.
      pairedDevice({ deviceId: 7 as unknown as string }),
    ],
    pairedNodes: [
      pairedNode({ nodeId: "good-node" }),
      pairedNode({ nodeId: {} as unknown as string }),
    ],
    pendingNodes: [pendingNode({ nodeId: [] as unknown as string })],
    connectedNodes: [],
  });
  const nodes = listKnownNodes(catalog);
  expect(nodes.map((entry) => entry.nodeId)).toEqual(["good-node"]);
  expect(catalog.get("good-node")).toBeDefined();
});

it("compares the normalized public pending surface before selecting approval diagnostics", () => {
  const pending = pendingNode({
    caps: [" screen ", "screen"],
    commands: [" screen.snapshot ", "screen.snapshot", ...NODE_WORKER_PRIVATE_COMMANDS],
    permissions: undefined,
  });
  const live = connectedNode({
    declaredCaps: ["screen"],
    declaredCommands: ["screen.snapshot"],
    connectedAtMs: 0,
  });
  const input = { pairedDevices: [], pendingNodes: [pending], connectedNodes: [live] };
  const node = createKnownNodeCatalog(input).get("mac-1");
  expect(node).toMatchObject({
    approvalState: "pending-approval",
    pendingDeclaredCaps: ["screen"],
    pendingDeclaredCommands: ["screen.snapshot"],
    caps: [],
    commands: [],
  });
  live.declaredCommands.push(NODE_WORKER_PRIVATE_COMMANDS[0]);
  expect(createKnownNodeCatalog(input).get("mac-1")).toMatchObject({
    approvalState: "unapproved",
    pendingRequestId: undefined,
    pendingDeclaredCaps: undefined,
    pendingDeclaredCommands: undefined,
  });
});

it("keeps row identity while cloning snapshots and excluding private source fields", () => {
  const permissions = { camera: true };
  const hostStats = {
    cpuCount: 4,
    memoryTotalBytes: 8192,
    memoryFreeBytes: 4096,
    updatedAtMs: 0,
  };
  const live = connectedNode({
    connId: "private-connection",
    connectedAtMs: 0,
    permissions,
    hostStats,
  });
  const workerSlots = { total: 2, available: 1 };
  const workerBundle = { status: "installed", version: "1" } as const;
  const catalog = createKnownNodeCatalog({
    pairedDevices: [pairedDevice()],
    pairedNodes: [pairedNode()],
    connectedNodes: [live],
    workerSlotsByNodeId: new Map([["mac-1", workerSlots]]),
    workerBundleByNodeId: new Map([["mac-1", workerBundle]]),
  });
  const node = expectDefined(catalog.get("mac-1"), "catalog row");
  expect(listKnownNodes(catalog)[0]).toBe(node);
  expect(listKnownNodes(catalog)).not.toBe(listKnownNodes(catalog));
  expect(catalog.get("absent")).toBeUndefined();
  expect(node.permissions).toBe(permissions);
  expect(node.nodePluginTools).toBe(live.nodePluginTools);
  expect(node.hostStats).toEqual(hostStats);
  expect(node.hostStats).not.toBe(hostStats);
  expect(node.workerSlots).toEqual(workerSlots);
  expect(node.workerSlots).not.toBe(workerSlots);
  expect(node.workerBundle).toEqual(workerBundle);
  expect(node.workerBundle).not.toBe(workerBundle);
  expect(Object.keys(node).toSorted()).toEqual(
    `nodeId displayName platform version coreVersion uiVersion clientId clientMode
       deviceFamily modelIdentifier remoteIp caps commands computerUse sessionHost hostStats
       workerSlots workerBundle nodePluginTools pathEnv permissions approvalState pendingRequestId
       pendingDeclaredCaps pendingDeclaredCommands pendingDeclaredPermissions connectedAtMs
       lastConnectedAtMs lastDisconnectedAtMs lastActiveAtMs presenceUpdatedAtMs lastSeenAtMs
       lastSeenReason approvedAtMs paired connected`
      .split(/\s+/)
      .toSorted(),
  );
  expect(node).toMatchObject({
    connectedAtMs: 0,
    lastConnectedAtMs: 0,
    lastSeenAtMs: undefined,
    lastSeenReason: undefined,
    lastDisconnectedAtMs: undefined,
    sessionHost: false,
  });
  hostStats.memoryFreeBytes = 1;
  workerSlots.available = 0;
  permissions.camera = false;
  expect(node.hostStats?.memoryFreeBytes).toBe(4096);
  expect(node.workerSlots?.available).toBe(1);
  expect(node.permissions?.camera).toBe(false);
});

it("keeps duplicate-source selection and last-seen tie precedence", () => {
  const catalog = createKnownNodeCatalog({
    pairedDevices: [pairedDevice({ lastSeenAtMs: 7, lastSeenReason: "device" })],
    pairedNodes: [
      pairedNode({ displayName: "Superseded" }),
      pairedNode({
        displayName: "Selected",
        lastSeenAtMs: 7,
        lastSeenReason: " surface ",
        lastConnectedAtMs: 7,
      }),
    ],
    pendingNodes: [pendingNode({ requestId: "newest" }), pendingNode({ requestId: "older" })],
    connectedNodes: [],
  });
  expect(catalog.get("mac-1")).toMatchObject({
    displayName: "Selected",
    pendingRequestId: "newest",
    lastSeenAtMs: 7,
    lastSeenReason: "surface",
  });
});
