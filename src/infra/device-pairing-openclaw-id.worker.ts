// The pairing transaction owns both the one-time receipt and the node-role grant.
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { approveDevicePairingInWorker } from "./device-pairing-approval.kernel.js";
import { removePairedDeviceRoleInWorker } from "./device-pairing-core.kernel.js";
import type {
  ApproveDevicePairingResult,
  DevicePairingAccessMetadata,
} from "./device-pairing-core.types.js";
import {
  loadDevicePairingStateForMutation,
  resolveRequestedDeviceRoles,
} from "./device-pairing-state.kernel.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import type { OpenClawIdNodePairingProvenance } from "./device-pairing.types.js";
import type { EngineConnection } from "./sql-connection.js";

const receiptKey = (peerKey: string) => `devicePairing.openclawIdNode.${peerKey}`;

/** An accepted node binding consumes automatic pairing even when it was approved manually. */
export function consumeOpenClawIdNodePairingInWorker(
  db: EngineConnection,
  peerKey: string,
): boolean {
  const key = receiptKey(peerKey);
  if (readConfigMachineStateRowInDatabase(db, key)) {
    return false;
  }
  writeConfigMachineStateInDatabase(db, key, true);
  return true;
}

type OpenClawIdNodePairingInput = {
  requestId: string;
  peerKey: string;
  authority: OpenClawIdNodePairingProvenance["authority"];
  deviceId: string;
  publicKey: string;
  commands: string[];
  caps: string[];
  displayName: string;
  accessMetadata?: DevicePairingAccessMetadata;
  nowMs: number;
};

/** Consume the peer's first approval and install its bounded surface in one transaction. */
export function approveOpenClawIdNodeInWorker(
  db: EngineConnection,
  input: OpenClawIdNodePairingInput,
): ApproveDevicePairingResult {
  const state = loadDevicePairingStateForMutation(input.nowMs);
  const pending = state.pendingById[input.requestId];
  // Never consume a pending operator request, repair, or previously granted role.
  if (
    !pending ||
    pending.deviceId !== input.deviceId ||
    pending.publicKey !== input.publicKey ||
    pending.clientMode !== "node" ||
    pending.isRepair ||
    state.pairedByDeviceId[pending.deviceId] ||
    pending.scopes?.length ||
    resolveRequestedDeviceRoles(pending).some((role) => role !== "node") ||
    pending.role !== "node"
  ) {
    return null;
  }
  const claimed = consumeOpenClawIdNodePairingInWorker(db, input.peerKey);
  if (!claimed) {
    return null;
  }
  const result = approveDevicePairingInWorker(
    input.requestId,
    {
      approvedVia: "openclaw-id-node",
      accessMetadata: input.accessMetadata,
    },
    input.nowMs,
  );
  if (result?.status !== "approved") {
    throw new Error("Node pairing approval changed inside its transaction");
  }
  result.device.tokens!.node!.approval = {
    approvedVia: "openclaw-id-node",
    peerKey: input.peerKey,
    authority: input.authority,
  };
  result.device.nodeSurface = {
    displayName: input.displayName,
    commands: input.commands,
    caps: input.caps,
    createdAtMs: input.nowMs,
    approvedAtMs: input.nowMs,
  };
  const approvedState = loadDevicePairingStateForMutation(input.nowMs);
  approvedState.pairedByDeviceId[input.deviceId] = result.device;
  persistDevicePairingStoreState(approvedState, undefined, "paired");
  // The receipt survives manual removal; token provenance identifies live grants.
  return result;
}

/** Remove every peer-bound node role, including manual re-pairings; suppression receipts stay. */
export function removeOpenClawIdNodePairingsInWorker(input: {
  peerKeys: readonly string[];
  sources?: readonly OpenClawIdNodePairingProvenance[];
  nowMs: number;
}): string[] {
  const peers = new Set(input.peerKeys);
  const removed: string[] = [];
  const state = loadDevicePairingStateForMutation(input.nowMs);
  for (const device of Object.values(state.pairedByDeviceId)) {
    const provenance = device.tokens?.node?.approval;
    if (
      !provenance ||
      !peers.has(provenance.peerKey) ||
      (input.sources &&
        !input.sources.some(
          (source) =>
            source.peerKey === provenance.peerKey &&
            source.authority.clawId === provenance.authority.clawId &&
            source.authority.rootPub === provenance.authority.rootPub &&
            source.authority.listedSeq === provenance.authority.listedSeq,
        ))
    ) {
      continue;
    }
    if (
      removePairedDeviceRoleInWorker({
        deviceId: device.deviceId,
        role: "node",
        nowMs: input.nowMs,
      })
    ) {
      removed.push(device.deviceId);
    }
  }
  return removed;
}
