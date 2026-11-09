import type { DeviceBootstrapMutationAdmission } from "./device-bootstrap.worker-types.js";
import type {
  DevicePairingPendingRecord,
  PairedDevice,
  PairedDevicePendingNodeSurface,
} from "./device-pairing.types.js";

export type NodePairingPendingSnapshot = Pick<PairedDevicePendingNodeSurface, "requestId"> & {
  nodeId: string;
  revision?: string;
};

export type DevicePairingAdmissionFacts =
  | {
      kind: "pairing-approval";
      pending: DevicePairingPendingRecord;
      existing: PairedDevice | undefined;
    }
  | { kind: "pairing-prune"; deviceIds: readonly string[] }
  | { kind: "pairing-token-issuance" }
  | ({ kind: "node-pending" } & NodePairingPendingSnapshot)
  | { kind: "node-surface"; nodeId: string; pairingGeneration?: string }
  | DeviceBootstrapMutationAdmission;
