import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeNodeApprovalSurfaceList,
  sameNodeApprovalSurfaceSet,
  sameNodePermissionSurface,
} from "../infra/node-pairing-surface.js";
import type {
  NodePairingPairedNode,
  NodePairingRequestInput,
  RequestNodePairingResult,
} from "../infra/node-pairing.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
} from "./node-command-policy.js";

export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  declaredCaps: string[];
  effectiveCaps: string[];
  declaredCommands: string[];
  effectiveCommands: string[];
  declaredPermissions?: Record<string, boolean>;
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
};

/** Replays approved node commands through the current runtime allowlist. */
function resolveApprovedReconnectCommands(params: {
  pairedCommands: readonly string[] | undefined;
  allowlist: Set<string>;
}) {
  return normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
    allowlist: params.allowlist,
  });
}

function normalizePermissionMap(
  value: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Keeps only declared approval surfaces that were already approved for this node. */
function intersectApprovalSurfaceList(params: {
  approved: readonly string[] | undefined;
  declared: readonly string[];
}): string[] {
  const approved = new Set(normalizeNodeApprovalSurfaceList(params.approved));
  return normalizeNodeApprovalSurfaceList(params.declared).filter((entry) => approved.has(entry));
}

function intersectPermissionSurface(params: {
  approved: Record<string, boolean> | undefined;
  declared: Record<string, boolean> | undefined;
}): Record<string, boolean> | undefined {
  const entries: Array<[string, boolean]> = [];
  for (const [key, declaredValue] of Object.entries(params.declared ?? {})) {
    const approvedValue = params.approved?.[key];
    if (!declaredValue) {
      // False declarations are explicit downgrades; keep them effective even
      // when the prior approved surface did not mention the key.
      entries.push([key, false]);
      continue;
    }
    if (approvedValue === true) {
      entries.push([key, true]);
      continue;
    }
    if (approvedValue === false) {
      entries.push([key, false]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Builds the pending approval payload from the normalized connect surfaces. */
function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
}): NodePairingRequestInput {
  return {
    nodeId: params.nodeId,
    displayName: params.connectParams.client.displayName,
    platform: params.connectParams.client.platform,
    version: params.connectParams.client.version,
    deviceFamily: params.connectParams.client.deviceFamily,
    modelIdentifier: params.connectParams.client.modelIdentifier,
    caps: params.caps,
    commands: params.commands,
    permissions: params.permissions,
    remoteIp: params.remoteIp,
  };
}

/** Reconciles a node connect declaration with its approved pairing record. */
export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<RequestNodePairingResult>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const policyNode = {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
    caps: params.connectParams.caps,
    commands: params.connectParams.commands,
  };
  const pairingAllowlist = resolveNodePairingCommandAllowlist(params.cfg, policyNode);
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    allowlist: pairingAllowlist,
  });
  const declaredCaps = normalizeNodeApprovalSurfaceList(params.connectParams.caps);
  const declaredPermissions = normalizePermissionMap(params.connectParams.permissions);

  if (!params.pairedNode) {
    // First connect starts approval with no live capability/command surface.
    // The node remains connected only with empty effective surfaces until
    // maintainers approve the pending request.
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        caps: declaredCaps,
        commands: declared,
        permissions: declaredPermissions,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      declaredCaps,
      effectiveCaps: [],
      declaredCommands: declared,
      effectiveCommands: [],
      declaredPermissions,
      effectivePermissions: undefined,
      pendingPairing,
    };
  }

  const runtimeAllowlist = resolveNodeCommandAllowlist(params.cfg, {
    ...policyNode,
    approvedCommands: params.pairedNode.commands,
  });
  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: params.pairedNode.commands,
    allowlist: runtimeAllowlist,
  });
  const approvedCaps = normalizeNodeApprovalSurfaceList(params.pairedNode.caps);
  const approvedPermissions = normalizePermissionMap(params.pairedNode.permissions);
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));
  const hasCapabilityChange = !sameNodeApprovalSurfaceSet(params.pairedNode.caps, declaredCaps);
  const hasPermissionChange = !sameNodePermissionSurface(
    params.pairedNode.permissions,
    declaredPermissions,
  );
  const effectiveApprovedDeclaredCaps = intersectApprovalSurfaceList({
    approved: approvedCaps,
    declared: declaredCaps,
  });
  const effectiveApprovedDeclaredCommands = intersectApprovalSurfaceList({
    approved: approvedCommands,
    declared,
  });
  const effectiveApprovedDeclaredPermissions = intersectPermissionSurface({
    approved: approvedPermissions,
    declared: declaredPermissions,
  });

  if (hasCommandUpgrade || hasCapabilityChange || hasPermissionChange) {
    // Upgrades/downgrades both create a fresh review item, but the live node
    // gets only the intersection of declared and already-approved surfaces.
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        caps: declaredCaps,
        commands: declared,
        permissions: declaredPermissions ?? (hasPermissionChange ? {} : undefined),
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      declaredCaps,
      effectiveCaps: effectiveApprovedDeclaredCaps,
      declaredCommands: declared,
      effectiveCommands: effectiveApprovedDeclaredCommands,
      declaredPermissions,
      effectivePermissions: effectiveApprovedDeclaredPermissions,
      pendingPairing,
    };
  }

  return {
    nodeId,
    declaredCaps,
    effectiveCaps: declaredCaps,
    declaredCommands: declared,
    effectiveCommands: declared,
    declaredPermissions,
    effectivePermissions: declaredPermissions,
  };
}
