import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { prepareDevicePairingBinding } from "../infra/device-pairing-binding.js";
import type { DevicePairingBinding } from "../infra/device-pairing-read.types.js";
import * as pairingReads from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { NODE_WORKER_PRIVATE_COMMANDS } from "../infra/node-commands.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import { readKnownNodeCatalog } from "./node-catalog-read.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry, type NodeSession } from "./node-registry.js";
import { makeClient } from "./node-registry.test-helpers.js";

function pairedDevice(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "mac-1",
    publicKey: "public-key",
    displayName: "Mac",
    platform: "macos",
    clientId: "openclaw-macos",
    clientMode: "node",
    role: "node",
    roles: ["node"],
    tokens: { node: { token: "current-token", role: "node", scopes: [], createdAtMs: 1 } },
    createdAtMs: 1,
    approvedAtMs: 99,
    ...overrides,
  };
}

function nodeSurface(overrides: Partial<NonNullable<PairedDevice["nodeSurface"]>> = {}) {
  return {
    caps: ["camera"],
    commands: ["system.run"],
    createdAtMs: 1,
    approvedAtMs: 100,
    ...overrides,
  };
}

function pendingSurface(
  overrides: Partial<NonNullable<PairedDevice["pendingNodeSurface"]>> = {},
): NonNullable<PairedDevice["pendingNodeSurface"]> {
  return {
    requestId: "request-1",
    revision: "revision-1",
    platform: "macos",
    caps: ["camera", "screen"],
    commands: ["screen.snapshot", "system.run"],
    permissions: { camera: true, screen: true },
    ts: 200,
    ...overrides,
  };
}

function createCatalogFixture(
  devices: Partial<PairedDevice> | PairedDevice[] = {},
  connections: Partial<NodeSession>[] = [],
) {
  const paired = Array.isArray(devices) ? devices : [pairedDevice(devices)];
  const bindings = new Map<string, DevicePairingBinding>();
  for (const device of paired) {
    const { binding } = prepareDevicePairingBinding(device.deviceId, device);
    if (binding) {
      bindings.set(device.deviceId, binding);
    }
  }
  vi.spyOn(pairingReads, "readDevicePairingNodeSnapshot").mockResolvedValue({ paired, bindings });
  const registry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => bindings.get(nodeId),
  });
  const sessions = connections.map((connection, index) => {
    const nodeId = connection.nodeId ?? "mac-1";
    const connId = connection.connId ?? `connection-${index}`;
    const client = makeClient(connId, nodeId, [], {
      clientId: "node-host",
      displayName: connection.displayName,
      platform: connection.platform,
      caps: connection.caps,
      commands: connection.commands,
      permissions: connection.permissions,
      declaredCaps: connection.declaredCaps,
      declaredCommands: connection.declaredCommands,
      declaredPermissions: connection.declaredPermissions,
    });
    const binding = expectDefined(bindings.get(nodeId), `${nodeId} binding`);
    const session = registry.register(client, {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    });
    // Include admitted malformed/legacy metadata without bypassing catalog publication.
    Object.assign(session, {
      declaredCaps: [],
      caps: [],
      declaredCommands: [],
      commands: [],
      connectedAtMs: 1,
      ...connection,
    });
    onTestFinished(() => {
      registry.unregister(connId);
    });
    return session;
  });
  return { registry, sessions, read: () => readKnownNodeCatalog(registry) };
}

async function publishRunner(
  fixture: ReturnType<typeof createCatalogFixture>,
  workerHost: NodeWorkerHostDeclaration,
) {
  const node = expectDefined(fixture.sessions[0], "live node");
  updateNodeRunnerInventory({
    registry: fixture.registry,
    nodeId: node.nodeId,
    connId: node.connId,
    declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost },
  });
}

afterEach(() => vi.restoreAllMocks());

it("never projects private worker controls from persisted or pending state", async () => {
  const fixture = createCatalogFixture({
    nodeSurface: nodeSurface({ commands: ["system.run", ...NODE_WORKER_PRIVATE_COMMANDS] }),
    pendingNodeSurface: pendingSurface({
      commands: ["screen.snapshot", ...NODE_WORKER_PRIVATE_COMMANDS],
    }),
  });
  const node = (await fixture.read()).nodes[0];
  expect(node?.commands).toEqual(["system.run"]);
  expect(node?.pendingDeclaredCommands).toEqual(["screen.snapshot"]);
});

it("falls back to the live node name when pairing has no name", async () => {
  const fixture = createCatalogFixture(
    { displayName: undefined, nodeSurface: nodeSurface({ displayName: undefined }) },
    [{ displayName: "Live Fallback" }],
  );
  expect((await fixture.read()).nodes[0]?.displayName).toBe("Live Fallback");
});

it("publishes live host and folder consent only while connected", async () => {
  for (const sessionHost of [false, true]) {
    const fixture = createCatalogFixture(
      { nodeSurface: nodeSurface({ sessionHost: !sessionHost }) },
      [{}],
    );
    const capacity = { total: 2, available: Number(sessionHost) };
    await publishRunner(
      fixture,
      sessionHost ? { enabled: true, capacity, deviceFolders: true } : { enabled: false },
    );
    const node = (await fixture.read()).nodes[0];
    expect(node).toMatchObject({ connected: true, sessionHost });
    expect(node?.workerSlots).toEqual(sessionHost ? capacity : undefined);
    expect(node?.workerHost).toEqual(sessionHost ? { deviceFolders: true } : undefined);
    fixture.registry.unregister(expectDefined(fixture.sessions[0], "live node").connId);
    expect((await fixture.read()).nodes[0]?.workerHost).toBeUndefined();
  }
});

it("uses pending request metadata as the final fallback for pending-only nodes", async () => {
  const metadata = {
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
  const fixture = createCatalogFixture({
    deviceId: "new-node",
    tokens: {},
    pendingNodeSurface: pendingSurface(metadata),
  });
  const node = (await fixture.read()).nodes[0];
  expect(node).toMatchObject({
    nodeId: "new-node",
    ...metadata,
    approvalState: "pending-approval",
    pendingRequestId: "request-1",
    caps: [],
    commands: [],
    paired: false,
    connected: false,
  });
  expect(node?.permissions).toBeUndefined();
  for (const view of ["environments", "worker-environments"] as const) {
    expect((await readKnownNodeCatalog(fixture.registry, view)).nodes).toEqual([]);
  }
});

it.each([true, false])(
  "selects pending reapproval only for matching live declarations: %s",
  async (widened) => {
    const caps = ["camera", "screen"];
    const commands = ["screen.snapshot", "system.run"];
    const permissions = { camera: true, screen: true };
    const fixture = createCatalogFixture(
      {
        nodeSurface: nodeSurface({
          commands: ["screen.snapshot"],
          permissions: { camera: true },
        }),
        pendingNodeSurface: pendingSurface(),
      },
      [
        {
          displayName: "Mac",
          platform: "macos",
          caps: ["camera"],
          commands: ["screen.snapshot"],
          permissions: { camera: true },
          declaredCaps: widened ? caps : ["camera"],
          declaredCommands: widened ? commands : ["screen.snapshot"],
          declaredPermissions: widened ? permissions : { camera: true },
        },
      ],
    );
    const node = (await fixture.read()).nodes[0];
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

it("ignores malformed node capability entries instead of throwing", async () => {
  const fixture = createCatalogFixture({ deviceId: "bad-node" }, [{ nodeId: "bad-node" }]);
  Object.assign(expectDefined(fixture.sessions[0], "live node"), {
    displayName: "Bad Node",
    caps: ["camera", undefined],
    commands: ["system.run", null],
  });
  const catalog = (await fixture.read()).nodes;
  expect(catalog).toHaveLength(1);
  expect(catalog[0]?.nodeId).toBe("bad-node");
  expect(catalog[0]?.caps).toEqual(["camera"]);
  expect(catalog[0]?.commands).toEqual(["system.run"]);
});

it("normalizes non-string scalar fields from malformed pairing records (no nodes-status crash)", async () => {
  // Corrupt persisted scalars must not reach status formatters' string operations.
  const device = pairedDevice({ platform: "linux", nodeSurface: nodeSurface() });
  Object.assign(device, {
    displayName: 654,
    clientId: 456,
    clientMode: 789,
    remoteIp: 22,
    deviceFamily: 33,
  });
  Object.assign(expectDefined(device.nodeSurface, "approved surface"), {
    version: 123,
    displayName: 321,
    modelIdentifier: 44,
  });
  const fixture = createCatalogFixture([device], [{}]);
  Object.assign(expectDefined(fixture.sessions[0], "live node"), {
    platform: {},
    version: undefined,
    clientId: undefined,
    clientMode: undefined,
  });
  expect((await fixture.read()).nodes[0]).toMatchObject({
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

it.each([7, {}, []])(
  "drops malformed persisted pairing ids before the catalog sort: %j",
  async (deviceId) => {
    const invalid = pairedDevice({
      nodeSurface: nodeSurface(),
      pendingNodeSurface: pendingSurface(),
    });
    Object.assign(invalid, { deviceId });
    const fixture = createCatalogFixture([
      pairedDevice({ deviceId: "good-node", nodeSurface: nodeSurface() }),
      invalid,
    ]);
    expect((await fixture.read()).nodes.map((entry) => entry.nodeId)).toEqual(["good-node"]);
  },
);

it.each([undefined, { camera: true, screen: true }])(
  "normalizes pending approval with omitted live permissions and pending permissions %j",
  async (permissions) => {
    const device = pairedDevice({
      pendingNodeSurface: pendingSurface({
        caps: [" screen ", "screen"],
        commands: [" screen.snapshot ", "screen.snapshot", ...NODE_WORKER_PRIVATE_COMMANDS],
        permissions,
      }),
    });
    const live = {
      declaredCaps: ["screen"],
      declaredCommands: ["screen.snapshot"],
      connectedAtMs: 0,
    };
    const fixture = createCatalogFixture([device], [live]);
    expect((await fixture.read()).nodes[0]).toMatchObject({
      approvalState: "pending-approval",
      pendingRequestId: "request-1",
      pendingDeclaredCaps: ["screen"],
      pendingDeclaredCommands: ["screen.snapshot"],
      pendingDeclaredPermissions: permissions,
      permissions: undefined,
      caps: [],
      commands: [],
    });
    const replacement = createCatalogFixture(
      [device],
      [
        {
          ...live,
          declaredCommands: [...live.declaredCommands, NODE_WORKER_PRIVATE_COMMANDS[0]],
        },
      ],
    );
    expect((await replacement.read()).nodes[0]).toMatchObject({
      approvalState: "unapproved",
      pendingRequestId: undefined,
      pendingDeclaredCaps: undefined,
      pendingDeclaredCommands: undefined,
    });
  },
);

it("publishes detached immutable node metadata without private source fields", async () => {
  const permissions = { camera: true };
  const fixture = createCatalogFixture({ nodeSurface: nodeSurface() }, [
    { connId: "private-connection", connectedAtMs: 0, permissions },
  ]);
  const catalog = (await fixture.read()).nodes;
  const node = expectDefined(catalog[0], "catalog row");
  const live = expectDefined(fixture.sessions[0], "live node");
  expect(node.permissions).toEqual(permissions);
  expect(node.permissions).not.toBe(permissions);
  expect(node.nodePluginTools).toEqual([]);
  expect(node.nodePluginTools).not.toBe(live.nodePluginTools);
  for (const key of [
    "client",
    "connId",
    "pairingIdentity",
    "pairingGeneration",
    "tokens",
    "publicKey",
    "declaredCaps",
    "declaredCommands",
    "declaredPermissions",
  ]) {
    expect(node).not.toHaveProperty(key);
  }
  expect(node).toMatchObject({
    connectedAtMs: 0,
    lastConnectedAtMs: 0,
    lastSeenAtMs: undefined,
    lastSeenReason: undefined,
    lastDisconnectedAtMs: undefined,
    sessionHost: false,
  });
  for (const value of [catalog, node, node.permissions, node.nodePluginTools]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
  expect(() =>
    Object.assign(expectDefined(node.permissions, "published permissions"), { camera: false }),
  ).toThrow();
  permissions.camera = false;
  expect(node.permissions).toEqual({ camera: true });
});

it("keeps duplicate-source selection, newest pending request and last-seen tie precedence", async () => {
  const fixture = createCatalogFixture([
    pairedDevice({
      nodeSurface: nodeSurface({ displayName: "Superseded", approvedAtMs: 101 }),
      pendingNodeSurface: pendingSurface({ requestId: "older", ts: 100 }),
    }),
    pairedDevice({
      lastSeenAtMs: 7,
      lastSeenReason: " surface ",
      nodeSurface: nodeSurface({ displayName: "Selected", lastConnectedAtMs: 7 }),
      pendingNodeSurface: pendingSurface({ requestId: "newest", ts: 200 }),
    }),
    // Keep the final device record distinct from the selected approved surface.
    pairedDevice({ lastSeenAtMs: 7, lastSeenReason: "device" }),
  ]);
  expect((await fixture.read()).nodes[0]).toMatchObject({
    displayName: "Selected",
    pendingRequestId: "newest",
    lastSeenAtMs: 7,
    lastSeenReason: "surface",
  });
});
