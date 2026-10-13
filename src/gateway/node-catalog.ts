import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { NodePairingPendingRequest, PairedDeviceNode } from "../infra/device-pairing-node.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import { filterPublicNodeCommands } from "../infra/node-commands.js";
import {
  sameNodeApprovalSurfaceSet,
  sameNodePermissionSurface,
} from "../infra/node-pairing-surface.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import type { NodeSession } from "./node-registry.js";

type KnownNodePendingSource = NodePairingPendingRequest & {
  caps: string[];
  commands: string[];
};

type KnownNodeCatalog = Map<string, NodeListNode>;

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

export function createKnownNodeCatalog(params: {
  pairedDevices: readonly PairedDevice[];
  pairedNodes?: readonly PairedDeviceNode[];
  pendingNodes?: readonly NodePairingPendingRequest[];
  connectedNodes: readonly NodeSession[];
  sessionHostNodeIds?: ReadonlySet<string>;
  workerSlotsByNodeId?: ReadonlyMap<string, NonNullable<NodeListNode["workerSlots"]>>;
  workerBundleByNodeId?: ReadonlyMap<string, NonNullable<NodeListNode["workerBundle"]>>;
  issuesByNodeId?: ReadonlyMap<string, NodeListNode["issues"]>;
}): KnownNodeCatalog {
  const devicePairingById = new Map(
    params.pairedDevices
      .filter(
        (entry) => hasNonEmptyString(entry.deviceId) && hasEffectivePairedDeviceRole(entry, "node"),
      )
      .map((entry) => [entry.deviceId, entry]),
  );
  // Prepare every approved command surface before duplicate selection, even when a live
  // session supplies the effective commands. The remaining metadata needs no copy.
  const nodePairingById = new Map(
    (params.pairedNodes ?? [])
      .filter((entry) => hasNonEmptyString(entry.nodeId))
      .map((entry) => [
        entry.nodeId,
        { node: entry, commands: filterPublicNodeCommands(entry.commands ?? []) },
      ]),
  );
  const pendingNodePairingById = new Map<string, KnownNodePendingSource>();
  // listNodePairing returns newest requests first; keep the current approval action per node.
  for (const entry of params.pendingNodes ?? []) {
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
  const liveById = new Map(params.connectedNodes.map((entry) => [entry.nodeId, entry]));
  const nodeIds = new Set<string>([
    ...devicePairingById.keys(),
    ...nodePairingById.keys(),
    ...pendingNodePairingById.keys(),
    ...liveById.keys(),
  ]);
  const catalog: KnownNodeCatalog = new Map();
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
    const workerSlots = params.workerSlotsByNodeId?.get(nodeId);
    const workerBundle = params.workerBundleByNodeId?.get(nodeId);
    const issues = params.issuesByNodeId?.get(nodeId);
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
    catalog.set(nodeId, {
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
        ? params.sessionHostNodeIds?.has(nodeId) === true
        : nodePairing?.sessionHost === true,
      ...(hostStats ? { hostStats: structuredClone(hostStats) } : {}),
      ...(live && workerSlots ? { workerSlots: { ...workerSlots } } : {}),
      ...(live && workerBundle ? { workerBundle: structuredClone(workerBundle) } : {}),
      ...(issues?.length ? { issues: [...issues] } : {}),
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
  return catalog;
}

/** Lists known nodes with connected nodes first and deterministic display ordering. */
export function listKnownNodes(catalog: KnownNodeCatalog): NodeListNode[] {
  return [...catalog.values()].toSorted(compareKnownNodes);
}
