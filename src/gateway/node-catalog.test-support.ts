import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import { prepareDevicePairingBinding } from "../infra/device-pairing-binding.js";
import type { DevicePairingBinding } from "../infra/device-pairing-read.types.js";
import * as pairingReads from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  type NodeWorkerHostDeclaration,
} from "../infra/node-runner-inventory.js";
import type { NodeWorkerBundleStatus } from "../shared/node-list-types.js";
import { readKnownNodeCatalog } from "./node-catalog-read.js";
import {
  getNodeWorkerSupervisorTransport,
  updateNodeRunnerInventory,
} from "./node-registry-private.js";
import { NodeRegistry, type NodeSession } from "./node-registry.js";
import { makeClient } from "./node-registry.test-helpers.js";

export function pairedDevice(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "mac-1",
    publicKey: "public-key",
    displayName: "Mac",
    platform: "macos",
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
  };
}

export function nodeSurface(overrides: Partial<NonNullable<PairedDevice["nodeSurface"]>> = {}) {
  return {
    caps: ["camera"],
    commands: ["system.run"],
    createdAtMs: 1,
    approvedAtMs: 100,
    ...overrides,
  };
}

export function pendingSurface(
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

export function createCatalogFixture(
  paired: PairedDevice[],
  connections: Partial<NodeSession>[] = [],
) {
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

export async function publishRunner(
  fixture: ReturnType<typeof createCatalogFixture>,
  workerHost: NodeWorkerHostDeclaration,
  bundle?: NodeWorkerBundleStatus,
) {
  const node = expectDefined(fixture.sessions[0], "live node");
  updateNodeRunnerInventory({
    registry: fixture.registry,
    nodeId: node.nodeId,
    connId: node.connId,
    declaration: { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost },
  });
  if (bundle) {
    const transport = getNodeWorkerSupervisorTransport(fixture.registry);
    const proof = expectDefined(await transport.getCurrentNode(node.nodeId), "runner proof");
    transport.acceptBundleStatus?.(proof, { bundleHash: "a".repeat(64), status: bundle });
  }
}
