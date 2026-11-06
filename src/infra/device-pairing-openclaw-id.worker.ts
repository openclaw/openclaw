// The pairing transaction owns both the one-time receipt and the node-role grant.
import type { DB } from "../state/openclaw-state-db.generated.js";
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
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";

const receiptKey = (peerKey: string) => `devicePairing.openclawIdNode.${peerKey}`;

export type OpenClawIdNodePairingInput = {
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
  const kysely = getNodeSqliteKysely<DB>(db);
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
  const claimed = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .insertInto("config_machine_state")
      .values({
        state_key: receiptKey(input.peerKey),
        value_json: JSON.stringify({ deviceId: input.deviceId, publicKey: input.publicKey }),
        updated_at_ms: input.nowMs,
      })
      .onConflict((conflict) => conflict.column("state_key").doNothing())
      .returning("state_key"),
  );
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

/** Remove only the role granted by these peers; receipts remain permanent suppression tombstones. */
export function removeOpenClawIdNodePairingsInWorker(
  db: EngineConnection,
  input: {
    peerKeys: readonly string[];
    sources?: readonly OpenClawIdNodePairingProvenance[];
    nowMs: number;
  },
): string[] {
  const kysely = getNodeSqliteKysely<DB>(db);
  const removed: string[] = [];
  for (const peerKey of new Set(input.peerKeys)) {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", receiptKey(peerKey)),
    );
    if (!row) {
      continue;
    }
    // SAFETY: This transaction is the sole writer of the typed receipt payload.
    const receipt = JSON.parse(row.value_json) as { deviceId: string; publicKey: string };
    const device = loadDevicePairingStateForMutation(input.nowMs).pairedByDeviceId[
      receipt.deviceId
    ];
    const provenance = device?.tokens?.node?.approval;
    if (
      !device ||
      device.publicKey !== receipt.publicKey ||
      provenance?.peerKey !== peerKey ||
      (input.sources &&
        !input.sources.some(
          (source) =>
            source.peerKey === peerKey &&
            source.authority.clawId === provenance.authority.clawId &&
            source.authority.rootPub === provenance.authority.rootPub &&
            source.authority.listedSeq === provenance.authority.listedSeq,
        ))
    ) {
      continue;
    }
    if (
      removePairedDeviceRoleInWorker({
        deviceId: receipt.deviceId,
        role: "node",
        nowMs: input.nowMs,
      })
    ) {
      removed.push(receipt.deviceId);
    }
  }
  return removed;
}
