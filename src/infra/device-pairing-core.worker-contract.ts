import type { DeviceBootstrapProfile } from "../shared/device-bootstrap-profile.js";
import type {
  ApproveDevicePairingResult,
  DevicePairingAccessMetadata,
  DevicePairingApprovalOptions,
  NodePairingGeneration,
  PairedDeviceMetadataPatch,
  PrunedSupersededPairedDevice,
  RequestDevicePairingResult,
  RevokeDeviceTokenResult,
  RotateDeviceTokenResult,
} from "./device-pairing-core.types.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  DevicePairingPendingRecord,
  PairedDevice,
} from "./device-pairing.types.js";

export type DevicePairingCoreAdmissionFacts =
  | {
      kind: "pairing-approval";
      pending: DevicePairingPendingRecord;
      existing: PairedDevice | undefined;
    }
  | { kind: "pairing-prune"; deviceIds: readonly string[] }
  | { kind: "pairing-token-issuance" };

export type DevicePairingCoreWorkerOperations = {
  "devicePairing.request": {
    input: {
      request: Omit<DevicePairingPendingRequest, "requestId" | "ts" | "isRepair">;
      nowMs: number;
    };
    output: RequestDevicePairingResult;
  };
  "devicePairing.reject": {
    input: { requestId: string; nowMs: number };
    output: { requestId: string; deviceId: string } | null;
  };
  "devicePairing.remove": {
    input: { deviceId: string; nowMs: number };
    output: { deviceId: string } | null;
  };
  "devicePairing.pruneSilent": {
    input: { deviceId: string; protectedDeviceIds: readonly string[]; nowMs: number };
    output: PrunedSupersededPairedDevice[];
  };
  "devicePairing.removeRole": {
    input: { deviceId: string; role: string; nowMs: number };
    output: { deviceId: string; role: string; removedDevice: boolean } | null;
  };
  "devicePairing.updateMetadata": {
    input: { deviceId: string; patch: Partial<PairedDeviceMetadataPatch>; nowMs: number };
    output: boolean;
  };
  "devicePairing.updatePresence": {
    input: {
      deviceId: string;
      patch: { lastSeenAtMs: number; lastSeenReason: string };
      expectedPairingGeneration: NodePairingGeneration;
    };
    output: boolean;
  };
  "devicePairing.approve": {
    input: {
      requestId: string;
      options?: Omit<DevicePairingApprovalOptions, "isApprovalCurrent">;
      nowMs: number;
    };
    output: ApproveDevicePairingResult;
  };
  "devicePairing.approveBootstrap": {
    input: {
      requestId: string;
      bootstrapProfile: DeviceBootstrapProfile;
      accessMetadata?: DevicePairingAccessMetadata;
      nowMs: number;
    };
    output: { result: ApproveDevicePairingResult; replacedRoles: string[] };
  };
  "devicePairing.verifyToken": {
    input: {
      deviceId: string;
      token: string;
      role: string;
      scopes: string[];
      requiredSharedGatewaySessionGeneration?: string;
      nowMs: number;
    };
    output: { ok: boolean; reason?: string; issuer?: DeviceAuthToken["issuer"] };
  };
  "devicePairing.ensureToken": {
    input: {
      deviceId: string;
      role: string;
      scopes: string[];
      issuer?: DeviceAuthToken["issuer"];
      nowMs: number;
    };
    output: DeviceAuthToken | null;
  };
  "devicePairing.rotateToken": {
    input: {
      deviceId: string;
      role: string;
      scopes?: string[];
      callerScopes?: readonly string[];
      nowMs: number;
    };
    output: RotateDeviceTokenResult;
  };
  "devicePairing.revokeToken": {
    input: { deviceId: string; role: string; callerScopes?: readonly string[]; nowMs: number };
    output: RevokeDeviceTokenResult;
  };
};
