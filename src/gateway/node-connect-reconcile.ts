import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  NodePairingPairedNode,
  NodePairingPendingRequest,
  NodePairingRequestInput,
} from "../infra/node-pairing.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { ConnectParams } from "./protocol/index.js";

type PendingNodePairingResult = {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
};

export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  effectiveCommands: string[];
  pendingPairing?: PendingNodePairingResult;
};

function resolveApprovedReconnectCommands(params: {
  pairedCommands: readonly string[] | undefined;
  declaredCommands: readonly string[];
  allowlist: Set<string>;
  defaultAllowlist: Set<string>;
}) {
  const pairedCommands = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
    allowlist: params.allowlist,
  });
  const safeDefaultCommands = normalizeDeclaredNodeCommands({
    declaredCommands: params.declaredCommands.filter((command) =>
      params.defaultAllowlist.has(command),
    ),
    allowlist: params.allowlist,
  });
  return [...new Set([...pairedCommands, ...safeDefaultCommands])];
}

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  commands: string[];
  remoteIp?: string;
}): NodePairingRequestInput {
  return {
    nodeId: params.nodeId,
    displayName: params.connectParams.client.displayName,
    platform: params.connectParams.client.platform,
    version: params.connectParams.client.version,
    deviceFamily: params.connectParams.client.deviceFamily,
    modelIdentifier: params.connectParams.client.modelIdentifier,
    caps: params.connectParams.caps,
    commands: params.commands,
    remoteIp: params.remoteIp,
  };
}

export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<PendingNodePairingResult>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const nodePolicyContext = {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
  };
  const allowlist = resolveNodeCommandAllowlist(params.cfg, nodePolicyContext);
  const defaultAllowlist = resolveNodeCommandAllowlist({}, nodePolicyContext);
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    allowlist,
  });

  if (!params.pairedNode) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: declared,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCommands: declared,
      pendingPairing,
    };
  }

  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: params.pairedNode.commands,
    declaredCommands: declared,
    allowlist,
    defaultAllowlist,
  });
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));

  if (hasCommandUpgrade) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: declared,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCommands: approvedCommands,
      pendingPairing,
    };
  }

  return {
    nodeId,
    effectiveCommands: declared,
  };
}
