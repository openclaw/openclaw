import type { BoundDeviceBootstrapContext } from "./device-bootstrap.worker-types.js";
import type { DevicePairingPendingRequest, PairedDevice } from "./device-pairing.types.js";

export type DevicePairingReadCommand =
  | { type: "devicePairing.list"; nowMs: number; publishedRevision?: string }
  | { type: "devicePairing.lookup"; deviceId: string }
  | { type: "devicePairing.pending"; requestId: string; nowMs: number }
  | {
      type: "devicePairing.bootstrapContext";
      input: { token: string; deviceId: string; publicKey: string; nowMs: number };
    };

export type DevicePairingBinding = { identity: string; generation?: string };
export type DevicePairingBindingFact = { deviceId: string; binding: DevicePairingBinding | null };
export type DevicePairingReadReply = {
  ok: true;
  sourceAdmitted: true;
  revision: string;
  bindings: DevicePairingBindingFact[] | undefined;
} & (
  | {
      type: "devicePairing.list";
      list: { pending: DevicePairingPendingRequest[]; paired: PairedDevice[] };
    }
  | { type: "devicePairing.lookup"; device: PairedDevice | null }
  | { type: "devicePairing.pending"; pending: DevicePairingPendingRequest | null }
  | { type: "devicePairing.bootstrapContext"; context: BoundDeviceBootstrapContext | null }
);

export type CloudWorkerSetupCompletionPublication = {
  environmentId: string;
  nodeDeviceId: string;
  updatedAtMs: number;
};

export type DevicePairingCommitReceipt = {
  kind: "devicePairing";
  beforeRevision: string;
  revision: string;
  changed: DevicePairingBindingFact[];
  tokensReplaced?: { deviceId: string; roles: string[] };
  workerEnvironment?: CloudWorkerSetupCompletionPublication;
};
