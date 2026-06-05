// Gateway node connect reconciliation.
// Computes approved runtime surfaces and pending pairing upgrades on reconnect.
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
import { resolveNodeIdentityId } from "./node-identity.js";

// Node connect reconciliation turns declared caps/commands/permissions into the
// effective runtime surface. New or upgraded surfaces create a pending pairing
// request while already-approved surfaces are intersected with the declaration.
export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  registrationNodeId: string;
  declaredCaps: string[];
  effectiveCaps: string[];
  declaredCommands: string[];
  effectiveCommands: string[];
  declaredPermissions?: Record<string, boolean>;
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
};

function resolveApprovedReconnectCommands(params: {
  pairedCommands: readonly string[] | undefined;
  allowlist: Set<string>;
}) {
  return normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
    allowlist: params.allowlist,
  });
}

// Permissions are sorted before comparison/results so reconnects are stable
// even when clients send JSON object keys in different orders.
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

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPairedNodeOwnedByDevice(params: {
  pairedNode: NodePairingPairedNode;
  deviceId: string;
}): boolean {
  const ownerDeviceId = normalizeTrimmedString(params.pairedNode.ownerDeviceId);
  if (ownerDeviceId) {
    return ownerDeviceId === params.deviceId;
  }
  return params.pairedNode.nodeId === params.deviceId;
}

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
    ownerDeviceId: normalizeTrimmedString(params.connectParams.device?.id) || undefined,
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

/** Reconciles a connecting node against stored approval and requests pairing when needed. */
export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  trustInstanceId?: boolean;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<RequestNodePairingResult | null>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId =
    resolveNodeIdentityId(
      { connect: params.connectParams },
      { trustInstanceId: params.trustInstanceId },
    ) ?? params.connectParams.client.id;
  const deviceId = normalizeTrimmedString(params.connectParams.device?.id);
  const pairedNodeIsOwned =
    params.pairedNode && deviceId
      ? isPairedNodeOwnedByDevice({ pairedNode: params.pairedNode, deviceId })
      : false;
  const pairedNode = pairedNodeIsOwned ? params.pairedNode : null;
  const registrationNodeId =
    params.pairedNode && !pairedNodeIsOwned ? deviceId || params.connectParams.client.id : nodeId;
  // Owner-checked adoption (isPairedNodeOwnedByDevice via ownerDeviceId or fallback nodeId==deviceId)
  // intentionally allows moving persisted paired state from raw device id to custom signed nodeId
  // on upgrade. This is the P1 "changes persisted session identity semantics" risk before merge.
  // The ownerDeviceId binding (set at initial pairing) gates it to the authenticated device owner.
  // See node-identity.ts for the centralized resolver and owner-checked adoption semantics.
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

  if (!pairedNode) {
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
    if (!pendingPairing) {
      throw new Error("node pairing request required");
    }
    return {
      nodeId,
      registrationNodeId,
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
    approvedCommands: pairedNode.commands,
  });
  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: pairedNode.commands,
    allowlist: runtimeAllowlist,
  });
  const approvedCaps = normalizeNodeApprovalSurfaceList(pairedNode.caps);
  const approvedPermissions = normalizePermissionMap(pairedNode.permissions);
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));
  const hasCapabilityChange = !sameNodeApprovalSurfaceSet(pairedNode.caps, declaredCaps);
  const hasPermissionChange = !sameNodePermissionSurface(
    pairedNode.permissions,
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

  // A reconnect may use only the intersection of old approval and new
  // declaration until the upgraded caps/commands/permissions are approved.
  if (hasCommandUpgrade || hasCapabilityChange || hasPermissionChange) {
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
      registrationNodeId,
      declaredCaps,
      effectiveCaps: effectiveApprovedDeclaredCaps,
      declaredCommands: declared,
      effectiveCommands: effectiveApprovedDeclaredCommands,
      declaredPermissions,
      effectivePermissions: effectiveApprovedDeclaredPermissions,
      ...(pendingPairing ? { pendingPairing } : {}),
    };
  }

  return {
    nodeId,
    registrationNodeId,
    declaredCaps,
    effectiveCaps: declaredCaps,
    declaredCommands: declared,
    effectiveCommands: declared,
    declaredPermissions,
    effectivePermissions: declaredPermissions,
  };
}
