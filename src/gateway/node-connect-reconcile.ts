import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PairedDeviceNode,
  NodePairingRequestInput,
  RequestNodePairingResult,
} from "../infra/device-pairing-node.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  intersectNodePermissionSurface,
  normalizeNodeApprovalSurfaceList,
  sameNodeApprovalSurfaceSet,
} from "../infra/node-pairing-surface.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodePairingCommandAllowlist,
  retainFulfilledNodeCapabilities,
} from "./node-command-policy.js";

const log = createSubsystemLogger("gateway/node-connect");

const MAX_WITHHELD_LOG_NODES = 256;
// Cleared on Gateway close and in-process restart, so each Gateway start records
// every node's current outcome once at warn. Eviction only costs one extra warn.
const lastLoggedWithheldCommandsByNode = resolveGlobalMap<string, string[]>(
  Symbol.for("openclaw.nodeConnectWithheldCommandLogs"),
  "close-and-restart",
);

// Refusing a declared command is an operator-visible decision. Reconnects that
// repeat an already-logged decision drop to debug so a new or changed one stands out.
function logWithheldNodeCommands(nodeId: string, withheldCommands: string[]): void {
  if (withheldCommands.length === 0) {
    lastLoggedWithheldCommandsByNode.delete(nodeId);
    return;
  }
  const message = `node command surface withheld node=${nodeId} commands=${withheldCommands.join(",")}`;
  const previous = lastLoggedWithheldCommandsByNode.get(nodeId);
  if (previous && sameNodeApprovalSurfaceSet(previous, withheldCommands)) {
    log.debug(message);
    return;
  }
  lastLoggedWithheldCommandsByNode.delete(nodeId);
  pruneMapToMaxSize(lastLoggedWithheldCommandsByNode, MAX_WITHHELD_LOG_NODES - 1);
  lastLoggedWithheldCommandsByNode.set(nodeId, withheldCommands);
  log.warn(message);
}

// Node connect reconciliation turns declared caps/commands/permissions into the
// effective runtime surface. New or upgraded surfaces create a pending pairing
// request while already-approved surfaces are intersected with the declaration.
type NodeConnectPairingReconcileResult = {
  nodeId: string;
  declaredCaps: string[];
  effectiveCaps: string[];
  declaredCommands: string[];
  effectiveCommands: string[];
  /** Commands the node declared that gateway policy refused to admit. */
  withheldCommands: string[];
  declaredComputerUse?: ComputerUseCapabilityDescriptor;
  declaredPermissions?: Record<string, boolean>;
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
  shouldClearPendingPairings?: boolean;
};

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

export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: PairedDeviceNode | null;
  reportedClientIp?: string;
  /**
   * Marks the first-surface capability request silent when device pairing was
   * approved non-interactively; approval UIs may then auto-approve it (macOS
   * SSH trust probe) instead of prompting. Upgrade requests stay interactive.
   */
  initialSurfaceSilent?: boolean;
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
  const connectCommands = normalizeNodeApprovalSurfaceList(params.connectParams.commands);
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: connectCommands,
    allowlist: pairingAllowlist,
  });
  // Caps and commands arrive as one advertisement and must stay one after policy,
  // or the node reads as capable and rejects every invoke. Refusing a declared
  // command is an operator-visible decision, so it is recorded where it happens.
  const withheldCommands = connectCommands.filter((command) => !declared.includes(command));
  const declaredCaps = retainFulfilledNodeCapabilities({
    caps: normalizeNodeApprovalSurfaceList(params.connectParams.caps),
    admittedCommands: declared,
    withheldCommands,
  });
  logWithheldNodeCommands(nodeId, withheldCommands);
  const declaredPermissions = normalizePermissionMap(params.connectParams.permissions);
  const declaredComputerUse =
    params.connectParams.computerUse === undefined
      ? undefined
      : parseComputerUseCapabilityDescriptor(params.connectParams.computerUse);
  const declaration = {
    nodeId,
    declaredCaps,
    declaredCommands: declared,
    withheldCommands,
    ...(declaredComputerUse ? { declaredComputerUse } : {}),
    declaredPermissions,
  };

  // Approved commands reconcile against the pairing allowlist. Dangerous
  // surfaces awaiting persistent enablement must not read as a pairing upgrade
  // on every reconnect; invoke-time policy still applies the runtime allowlist.
  const { pairedNode } = params;
  const approvedCommands = new Set(
    normalizeDeclaredNodeCommands({
      declaredCommands: pairedNode?.commands,
      allowlist: pairingAllowlist,
    }),
  );
  const approvedCaps = new Set(normalizeNodeApprovalSurfaceList(pairedNode?.caps));
  const approvedPermissions = normalizePermissionMap(pairedNode?.permissions);
  // Availability and permission loss only narrow the live surface. Reapproval
  // is required when a reconnect widens authority beyond the durable approval.
  if (
    pairedNode &&
    declared.every((command) => approvedCommands.has(command)) &&
    declaredCaps.every((capability) => approvedCaps.has(capability)) &&
    !Object.entries(declaredPermissions ?? {}).some(
      ([key, granted]) => granted && approvedPermissions?.[key] !== true,
    )
  ) {
    return {
      ...declaration,
      effectiveCaps: declaredCaps,
      effectiveCommands: declared,
      effectivePermissions: declaredPermissions,
      shouldClearPendingPairings: true,
    };
  }

  const effectiveCaps = declaredCaps.filter((cap) => approvedCaps.has(cap));
  const effectiveCommands = declared.filter((command) => approvedCommands.has(command));
  const effectivePermissions = pairedNode
    ? intersectNodePermissionSurface({
        approved: approvedPermissions,
        declared: declaredPermissions,
      })
    : undefined;
  const { client } = params.connectParams;
  const pendingPairing = await params.requestPairing({
    nodeId,
    displayName: client.displayName,
    platform: client.platform,
    version: client.version,
    deviceFamily: client.deviceFamily,
    modelIdentifier: client.modelIdentifier,
    caps: declaredCaps,
    commands: declared,
    permissions: declaredPermissions,
    remoteIp: params.reportedClientIp,
    ...(!pairedNode && params.initialSurfaceSilent ? { silent: true } : {}),
  });
  if (!pairedNode && !pendingPairing) {
    throw new Error("node pairing request required");
  }
  return {
    ...declaration,
    effectiveCaps,
    effectiveCommands,
    effectivePermissions,
    ...(pendingPairing ? { pendingPairing } : {}),
  };
}
