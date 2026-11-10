// The pairing transaction owns both the per-listing receipt and the node-role grant.
import { createHash } from "node:crypto";
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

type NodeListing = Pick<OpenClawIdNodePairingProvenance, "peerKey" | "authority">;

// One receipt per owner-approved listing: removal and re-approval list W under a new seq, while
// re-approving a still-listed W keeps its seq. Peer-only receipts from unreleased builds are not read.
const receiptKey = ({ peerKey, authority }: NodeListing) =>
  `devicePairing.openclawIdNode.${peerKey}.${createHash("sha256")
    .update(JSON.stringify([authority.clawId, authority.rootPub, authority.listedSeq]))
    .digest("hex")}`;

/** A node grant under this listing consumes its automatic pairing, even when approved manually. */
export function consumeOpenClawIdNodePairingInWorker(
  db: EngineConnection,
  listing: NodeListing,
): boolean {
  const key = receiptKey(listing);
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

/** Consume this listing's automatic approval and install its bounded surface in one transaction. */
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
  const claimed = consumeOpenClawIdNodePairingInWorker(db, input);
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
  // The receipt survives manual removal under this listing; token provenance identifies live grants.
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
