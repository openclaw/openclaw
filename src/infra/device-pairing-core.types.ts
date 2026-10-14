import type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDeviceApprovalKind,
} from "./device-pairing.types.js";

export type PairedDeviceTokenIdentity = { deviceId: string; key: string };

export type NodePairingGeneration = {
  nodeId: string;
  key: string;
};

export type NodePairingState = {
  identity: { nodeId: string; key: string };
  generation: NodePairingGeneration | null;
};

/** Pending request summary returned when a replacement supersedes older requests. */
type DevicePairingSupersededRequest = Pick<DevicePairingPendingRequest, "requestId" | "deviceId">;

export type RequestDevicePairingResult = {
  status: "pending";
  request: DevicePairingPendingRequest;
  expiresAtMs: number;
  created: boolean;
  superseded?: DevicePairingSupersededRequest[];
};

/** Metadata fields a device may refresh without changing approval or token state. */
export type PairedDeviceMetadataPatch = Pick<
  PairedDevice,
  | "displayName"
  | "operatorLabel"
  | "platform"
  | "clientId"
  | "clientMode"
  | "remoteIp"
  | "lastSeenAtMs"
  | "lastSeenReason"
>;

export type RotateDeviceTokenDenyReason =
  | "unknown-device-or-role"
  | "missing-approved-scope-baseline"
  | "scope-outside-approved-baseline"
  | "caller-missing-scope";

export type RotateDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RotateDeviceTokenDenyReason; scope?: string };

export type RevokeDeviceTokenDenyReason = "unknown-device-or-role" | "caller-missing-scope";

export type RevokeDeviceTokenResult =
  | { ok: true; entry: DeviceAuthToken }
  | { ok: false; reason: RevokeDeviceTokenDenyReason; scope?: string };

/** Paired-device access metadata refreshed when an existing device reconnects. */
export type DevicePairingAccessMetadata = Pick<
  PairedDevice,
  "displayName" | "remoteIp" | "lastSeenAtMs" | "lastSeenReason"
>;

/** Authorization failure categories for owner approval and bootstrap approval flows. */
type DevicePairingForbiddenReason =
  | "caller-scopes-required"
  | "caller-missing-scope"
  | "scope-outside-requested-roles"
  | "approval-policy-changed"
  | "bootstrap-role-not-allowed"
  | "bootstrap-scope-not-allowed";

export type DevicePairingForbiddenResult = {
  status: "forbidden";
  reason: DevicePairingForbiddenReason;
  scope?: string;
  role?: string;
};

export type ApproveDevicePairingResult =
  | {
      status: "approved";
      requestId: string;
      device: PairedDevice;
      /** Existing connected node transports must be retired before success is returned. */
      nodePairingGenerationChanged?: true;
    }
  | DevicePairingForbiddenResult
  | null;

export type DevicePairingApprovalOptions = {
  callerScopes?: readonly string[];
  accessMetadata?: DevicePairingAccessMetadata;
  approvedVia?: Extract<
    PairedDeviceApprovalKind,
    "owner" | "silent" | "trusted-cidr" | "trusted-proxy" | "remote-ingress" | "ssh-verified"
  >;
  /** Revalidate automatic approval against current policy after all pairing-lock awaits. */
  isApprovalCurrent?: (state: {
    pending: Readonly<DevicePairingPendingRequest>;
    existing: Readonly<PairedDevice> | undefined;
  }) => boolean;
  /**
   * Replace pending scopes for a new operator device, or a trusted ingress
   * same-key upgrade. The live role set is rechecked under the pairing lock.
   */
  autoApproveNewDeviceScopes?: readonly string[];
};

export type DeviceBootstrapApprovalOptions = Pick<
  DevicePairingApprovalOptions,
  "accessMetadata" | "isApprovalCurrent"
> & {
  onTokensReplaced?: (deviceId: string, roles: readonly string[]) => void;
};

/** Superseded silent pairing removed in favor of a newer record for the same client. */
export type PrunedSupersededPairedDevice = {
  deviceId: string;
  roles: string[];
};
