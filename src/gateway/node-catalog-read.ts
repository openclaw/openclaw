import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { NodePairingPendingRequest, PairedDeviceNode } from "../infra/device-pairing-node.js";
import { projectNodePairing } from "../infra/device-pairing-node.records.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import { readDevicePairingNodeSnapshot } from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.js";
import { filterPublicNodeCommands } from "../infra/node-commands.js";
import {
  sameNodeApprovalSurfaceSet,
  sameNodePermissionSurface,
} from "../infra/node-pairing-surface.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import {
  collectNodeCatalogRuntimeState,
  readNodeCatalogRevision,
} from "./node-registry-private.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

type KnownNodePendingSource = NodePairingPendingRequest & {
  caps: string[];
  commands: string[];
};

function uniqueSortedStrings(...items: Array<readonly unknown[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}

// Persisted pairing metadata may be malformed; let valid lower-priority strings win.
function firstNormalizedString(...values: unknown[]): string | undefined {
  return normalizeOptionalString(values.find(hasNonEmptyString));
}

function maxDefinedTimestamp(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function resolveEffectiveLastSeen(
  live: NodeSession | undefined,
  devicePairing: PairedDevice | undefined,
  nodePairing: PairedDeviceNode | undefined,
): { lastSeenAtMs?: number; lastSeenReason?: string } {
  // Live connected time is the freshest signal; stored last-seen values fill in
  // disconnected rows without letting stale device-pairing data override nodes.
  const candidates: Array<{ atMs: number; reason?: string }> = [
    live?.connectedAtMs ? { atMs: live.connectedAtMs, reason: "connect" } : undefined,
    nodePairing?.lastSeenAtMs
      ? { atMs: nodePairing.lastSeenAtMs, reason: nodePairing.lastSeenReason }
      : undefined,
    nodePairing?.lastConnectedAtMs
      ? { atMs: nodePairing.lastConnectedAtMs, reason: "connect" }
      : undefined,
    devicePairing?.lastSeenAtMs
      ? { atMs: devicePairing.lastSeenAtMs, reason: devicePairing.lastSeenReason }
      : undefined,
  ].filter((entry) => entry !== undefined);
  let newest: { atMs: number; reason?: string } | undefined;
  for (const candidate of candidates) {
    if (!newest || candidate.atMs > newest.atMs) {
      newest = candidate;
    }
  }
  if (!newest) {
    return {};
  }
  return {
    lastSeenAtMs: newest.atMs,
    lastSeenReason: normalizeOptionalString(newest.reason),
  };
}

function compareKnownNodes(left: NodeListNode, right: NodeListNode): number {
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  const leftName = normalizeLowercaseStringOrEmpty(left.displayName ?? left.nodeId);
  const rightName = normalizeLowercaseStringOrEmpty(right.displayName ?? right.nodeId);
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

type CatalogView = "nodes" | "environments" | "worker-environments";
type PreparedNodeCatalog = {
  nodes: readonly NodeListNode[];
  connectedNodes: readonly NodeSession[];
};
const preparedCatalogs = new WeakMap<
  NodeRegistry,
  {
    pairing: DevicePairingNodeSnapshot;
    revision: number;
    connectedNodes: NodeSession[];
    views: Map<CatalogView, PreparedNodeCatalog>;
  }
>();

/** Pairing publications and registry mutations own the lifetime of these read-only projections. */
export async function readKnownNodeCatalog(
  registry: NodeRegistry,
  view: CatalogView = "nodes",
): Promise<PreparedNodeCatalog> {
  const pairing = await readDevicePairingNodeSnapshot();
  const revision = readNodeCatalogRevision(registry);
  let prepared = preparedCatalogs.get(registry);
  if (
    !prepared ||
    prepared.pairing !== pairing ||
    prepared.revision !== revision ||
    // Connection policy can revoke a client before the transport unregisters it.
    prepared.connectedNodes.some((node) => node.client.invalidated === true)
  ) {
    prepared = {
      pairing,
      revision,
      connectedNodes: registry.listConnectedForPairingStates(pairing.bindings),
      views: new Map(),
    };
    preparedCatalogs.set(registry, prepared);
  }
  let result = prepared.views.get(view);
  if (!result) {
    const projectedPairing = projectNodePairing(pairing.paired);
    const runtime = collectNodeCatalogRuntimeState(
      registry,
      prepared.connectedNodes,
      view === "worker-environments",
    );
    const devicePairingById = new Map(
      pairing.paired
        .filter((device) => pairing.bindings.has(device.deviceId))
        .filter((entry) => hasNonEmptyString(entry.deviceId))
        .map((entry) => [entry.deviceId, entry]),
    );
    // Prepare every approved command surface before duplicate selection, even when a live
    // session supplies the effective commands. The remaining metadata needs no copy.
    const nodePairingById = new Map(
      projectedPairing.paired
        .filter((entry) => hasNonEmptyString(entry.nodeId))
        .map((entry) => [
          entry.nodeId,
          { node: entry, commands: filterPublicNodeCommands(entry.commands ?? []) },
        ]),
    );
    const pendingNodePairingById = new Map<string, KnownNodePendingSource>();
    // Environment discovery never exposes pending-only node metadata.
    // listNodePairing returns newest requests first; keep the current approval action per node.
    for (const entry of view === "nodes" ? projectedPairing.pending : []) {
      if (!hasNonEmptyString(entry.nodeId)) {
        continue;
      }
      if (!pendingNodePairingById.has(entry.nodeId)) {
        pendingNodePairingById.set(entry.nodeId, {
          ...entry,
          caps: uniqueSortedStrings(entry.caps),
          commands: filterPublicNodeCommands(uniqueSortedStrings(entry.commands)),
        });
      }
    }
    const liveById = new Map(prepared.connectedNodes.map((entry) => [entry.nodeId, entry]));
    const nodeIds = new Set<string>([
      ...devicePairingById.keys(),
      ...nodePairingById.keys(),
      ...pendingNodePairingById.keys(),
      ...liveById.keys(),
    ]);
    const catalog: NodeListNode[] = [];
    for (const nodeId of nodeIds) {
      const devicePairing = devicePairingById.get(nodeId);
      const approved = nodePairingById.get(nodeId);
      const nodePairing = approved?.node;
      const live = liveById.get(nodeId);
      let pendingNodePairing = pendingNodePairingById.get(nodeId);
      if (pendingNodePairing && live) {
        const declaredPermissions =
          !nodePairing && live.declaredPermissions === undefined
            ? pendingNodePairing.permissions
            : live.declaredPermissions;
        if (
          !sameNodeApprovalSurfaceSet(pendingNodePairing.caps, live.declaredCaps) ||
          !sameNodeApprovalSurfaceSet(pendingNodePairing.commands, live.declaredCommands) ||
          !sameNodePermissionSurface(pendingNodePairing.permissions, declaredPermissions)
        ) {
          pendingNodePairing = undefined;
        }
      }
      const workerSlots = runtime.workerSlotsByNodeId.get(nodeId);
      const workerBundle = runtime.workerBundleByNodeId.get(nodeId);
      const issues = runtime.issuesByNodeId.get(nodeId);
      const lastSeen = resolveEffectiveLastSeen(live, devicePairing, nodePairing);
      const lastConnectedAtMs = maxDefinedTimestamp(
        nodePairing?.lastConnectedAtMs,
        live?.connectedAtMs,
      );
      const lastDisconnectedAtMs = live ? undefined : nodePairing?.lastDisconnectedAtMs;
      const hostStats = live ? live.hostStats : nodePairing?.lastHostStats;
      const nodeMetadata = (
        key: "version" | "coreVersion" | "uiVersion" | "deviceFamily" | "modelIdentifier",
      ) => firstNormalizedString(live?.[key], nodePairing?.[key], pendingNodePairing?.[key]);
      catalog.push({
        nodeId,
        displayName: firstNormalizedString(
          // The approved surface owns the operator's rename. Live metadata is a
          // fallback only, or every reconnect would temporarily undo that choice.
          nodePairing?.displayName,
          live?.displayName,
          devicePairing?.displayName,
          pendingNodePairing?.displayName,
        ),
        platform: firstNormalizedString(
          live?.platform,
          nodePairing?.platform,
          devicePairing?.platform,
          pendingNodePairing?.platform,
        ),
        version: nodeMetadata("version"),
        coreVersion: nodeMetadata("coreVersion"),
        uiVersion: nodeMetadata("uiVersion"),
        clientId: firstNormalizedString(
          live?.clientId,
          devicePairing?.clientId,
          pendingNodePairing?.clientId,
        ),
        clientMode: firstNormalizedString(
          live?.clientMode,
          devicePairing?.clientMode,
          pendingNodePairing?.clientMode,
        ),
        deviceFamily: nodeMetadata("deviceFamily"),
        modelIdentifier: nodeMetadata("modelIdentifier"),
        remoteIp: firstNormalizedString(
          live?.remoteIp,
          nodePairing?.remoteIp,
          devicePairing?.remoteIp,
          pendingNodePairing?.remoteIp,
        ),
        caps: live ? uniqueSortedStrings(live.caps) : uniqueSortedStrings(nodePairing?.caps),
        commands: filterPublicNodeCommands(
          live ? uniqueSortedStrings(live.commands) : uniqueSortedStrings(approved?.commands),
        ),
        computerUse: live?.computerUse,
        // Live inventory is authoritative while connected; stored consent is
        // only the offline identity hint and never carries live capacity.
        sessionHost: live
          ? runtime.sessionHostNodeIds.has(nodeId)
          : nodePairing?.sessionHost === true,
        ...(live && runtime.deviceFolderNodeIds.has(nodeId)
          ? { workerHost: { deviceFolders: true } }
          : {}),
        ...(hostStats ? { hostStats } : {}),
        ...(live && workerSlots ? { workerSlots } : {}),
        ...(live && workerBundle ? { workerBundle } : {}),
        ...(issues?.length ? { issues } : {}),
        nodePluginTools: live?.nodePluginTools,
        pathEnv: live?.pathEnv,
        permissions: live?.permissions ?? nodePairing?.permissions,
        approvalState: pendingNodePairing
          ? nodePairing
            ? "pending-reapproval"
            : "pending-approval"
          : nodePairing
            ? "approved"
            : "unapproved",
        pendingRequestId: pendingNodePairing?.requestId,
        pendingDeclaredCaps: pendingNodePairing?.caps,
        pendingDeclaredCommands: pendingNodePairing?.commands,
        pendingDeclaredPermissions: pendingNodePairing?.permissions,
        connectedAtMs: live?.connectedAtMs,
        lastConnectedAtMs,
        lastDisconnectedAtMs,
        lastActiveAtMs: live?.lastActiveAtMs,
        presenceUpdatedAtMs: live?.presenceUpdatedAtMs,
        lastSeenAtMs: lastSeen.lastSeenAtMs,
        lastSeenReason: lastSeen.lastSeenReason,
        approvedAtMs: nodePairing?.approvedAtMs ?? devicePairing?.approvedAtMs,
        paired: Boolean(devicePairing ?? nodePairing),
        connected: Boolean(live),
      });
    }
    result = Object.freeze({
      nodes: freezeJsonSnapshot(structuredClone(catalog.toSorted(compareKnownNodes))),
      connectedNodes: Object.freeze(prepared.connectedNodes),
    });
    prepared.views.set(view, result);
  }
  return result;
}
