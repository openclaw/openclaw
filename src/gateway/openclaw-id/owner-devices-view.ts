// The owner devices "Your devices" lists: active devices only, each with who approved it.
import {
  isOwnerDeviceActive,
  type AuthorityState,
  type KeyFingerprint,
  type OwnerCapability,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";

/** An owner device as the owner's own devices see it: certificate, granted caps and approver. */
export type OwnerDeviceView = {
  cert: SignedStatement<"OwnerDeviceCert">;
  caps: OwnerCapability[];
  approved_by: "root" | KeyFingerprint;
};

/**
 * The claw's active owner devices for the owner-only link status. Expired and
 * earlier-epoch devices stay in the record but are no longer owners. `approvedBy` is
 * "root" (the recovery kit) or the approving device's fingerprint.
 */
export function describeOwnerDevices(state: AuthorityState, now: number) {
  return Object.entries(state.owner_devices)
    .filter(([, device]) => isOwnerDeviceActive(device, now))
    .map(([deviceFp, device]) => ({
      devicePub: device.cert.body.device_pub,
      deviceFp,
      label: device.cert.body.label,
      peerKeys: device.cert.body.peer_keys,
      approvedBy: device.approved_by,
      lastSeen: device.last_seen,
      cert: device.cert,
    }));
}
