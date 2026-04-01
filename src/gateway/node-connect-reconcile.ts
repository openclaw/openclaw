import type { OpenClawConfig } from "../config/config.js";
import type {
  NodePairingPairedNode,
  NodePairingPendingRequest,
  NodePairingRequestInput,
} from "../infra/node-pairing.js";
import {
  diffApprovedNodeCommands,
  resolveNodeCommandAllowlist,
  type NodeApprovedCommandDiff,
} from "./node-command-policy.js";
import type { ConnectParams } from "./protocol/index.js";

type PendingNodePairingResult = {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
};

export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  commandDiff: NodeApprovedCommandDiff;
  effectiveCommands: string[];
  pendingPairing?: PendingNodePairingResult;
};

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  commands: string[];
  remoteIp?: string;
  repairReason?: NodePairingRequestInput["repairReason"];
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
    repairReason: params.repairReason,
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
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
  });
  const commandDiff = diffApprovedNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    approvedCommands: params.pairedNode?.commands,
    allowlist,
  });

  if (!params.pairedNode) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: commandDiff.declared,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      commandDiff,
      effectiveCommands: [],
      pendingPairing,
    };
  }

  if (commandDiff.needsRepair) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: commandDiff.declared,
        remoteIp: params.reportedClientIp,
        repairReason: "approved-command-drift",
      }),
    );
    return {
      nodeId,
      commandDiff,
      effectiveCommands: commandDiff.effective,
      pendingPairing,
    };
  }

  return {
    nodeId,
    commandDiff,
    effectiveCommands: commandDiff.effective,
  };
}
