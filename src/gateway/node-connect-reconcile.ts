// Gateway node connect reconciliation.
// Computes approved runtime surfaces and pending pairing upgrades on reconnect.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
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
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
  resolveNodePairingCommandAllowlist,
} from "./node-command-policy.js";

// Node connect reconciliation turns declared caps/commands/permissions into the
// effective runtime surface. New or upgraded surfaces create a pending pairing
// request while already-approved surfaces are intersected with the declaration.
type NodeConnectPairingReconcileResult = {
  nodeId: string;
  declaredCaps: string[];
  effectiveCaps: string[];
  declaredCommands: string[];
  effectiveCommands: string[];
  declaredPermissions?: Record<string, boolean>;
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
  shouldClearPendingPairings?: boolean;
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

// Android devices that are already approved at the device-pairing level (role
// "node") but have no separate, explicit node-surface approval on record would
// otherwise have their entire declared command/cap surface collapsed to []
// (see openclaw/openclaw#87058, #97967). For Android specifically, the
// declared surface is already constrained by a platform-specific allowlist
// (resolveNodePairingCommandAllowlist / resolveNodeCommandAllowlist /
// normalizeDeclaredNodeCommands) before it ever reaches this function, so
// auto-adopting it as the effective surface does not expose any command that
// isn't already platform-safe or explicitly allowlisted via
// gateway.nodes.allowCommands. Non-Android node hosts keep the existing
// explicit node-pairing approval path unchanged.
function isAndroidNodeConnect(connectParams: ConnectParams): boolean {
  const platform = normalizeDeviceMetadataForPolicy(connectParams.client.platform);
  const deviceFamily = normalizeDeviceMetadataForPolicy(connectParams.client.deviceFamily);
  return (
    connectParams.client.id === GATEWAY_CLIENT_IDS.ANDROID_APP &&
    connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
    /^android(?:\s|$)/.test(platform) &&
    deviceFamily === "android"
  );
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

/** Reconciles a connecting node against stored approval and requests pairing when needed. */
export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<RequestNodePairingResult | null>;
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
    const isFirstConnectAndroidNode = isAndroidNodeConnect(params.connectParams);
    return {
      nodeId,
      declaredCaps,
      effectiveCaps: isFirstConnectAndroidNode ? declaredCaps : [],
      declaredCommands: declared,
      effectiveCommands: isFirstConnectAndroidNode ? declared : [],
      declaredPermissions,
      effectivePermissions: isFirstConnectAndroidNode ? declaredPermissions : undefined,
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
    declaredCaps,
    effectiveCaps: declaredCaps,
    declaredCommands: declared,
    effectiveCommands: declared,
    declaredPermissions,
    effectivePermissions: declaredPermissions,
    shouldClearPendingPairings: true,
  };
}
