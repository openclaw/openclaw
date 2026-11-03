// Owner devices for the account menu's "Your devices" (OCF-280): which listed
// device is this browser, who approved each device, which devices a device
// approved, and the signed Revocation that removes one. The claw keeps an
// allowlist: revoking a device deletes it together with every device it
// approved, directly or through devices it approved (from `approvedBy`).
import {
  fingerprint,
  formatEd25519PublicKey,
  ROOT_EPOCH,
  signStatement,
  type Ed25519PublicKey,
  type SignedStatement,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { loadOwnerDeviceSigner } from "./device-key.ts";
import type { OpenClawIdOwnerDevice, OpenClawIdPeopleLink } from "./types.ts";

/** Raised when this browser holds no active owner device key for the claw. */
class NotAnOwnerDeviceError extends Error {
  constructor() {
    super("This browser is not an owner device for this claw.");
  }
}

/** The listed owner device this browser signs as, or undefined. */
export async function thisOwnerDevice(
  link: OpenClawIdPeopleLink,
): Promise<OpenClawIdOwnerDevice | undefined> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  return link.ownerDevices?.find((device) => device.devicePub === devicePub);
}

/**
 * The other listed devices that lose access with `device`: those it approved,
 * directly or through devices it approved, as the claw computes it on removal.
 */
export function devicesApprovedBy(
  devices: readonly OpenClawIdOwnerDevice[],
  device: OpenClawIdOwnerDevice,
): OpenClawIdOwnerDevice[] {
  const removed = new Set([device.deviceFp]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const other of devices) {
      if (!removed.has(other.deviceFp) && removed.has(other.approvedBy)) {
        removed.add(other.deviceFp);
        grew = true;
      }
    }
  }
  return devices.filter(
    (other) => other.deviceFp !== device.deviceFp && removed.has(other.deviceFp),
  );
}

/**
 * Who approved `device`: the recovery kit, a listed device (by label), or a
 * device the claw no longer lists.
 */
export function approverOf(
  devices: readonly OpenClawIdOwnerDevice[],
  device: OpenClawIdOwnerDevice,
): { kind: "kit" } | { kind: "device"; label: string } | { kind: "removed" } {
  if (device.approvedBy === "root") {
    return { kind: "kit" };
  }
  const approver = devices.find((other) => other.deviceFp === device.approvedBy);
  return approver ? { kind: "device", label: approver.label } : { kind: "removed" };
}

/**
 * Signs a Revocation of `target` as this browser's owner device. The Gateway
 * checks this device is still listed, removes the target with the devices it
 * approved and cuts their connections.
 */
export async function signOwnerDeviceRevocation(
  link: OpenClawIdPeopleLink,
  target: OpenClawIdOwnerDevice,
): Promise<SignedStatement<"Revocation">> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const ownPub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  const own = link.ownerDevices?.find((device) => device.devicePub === ownPub);
  if (!signer || !own) {
    throw new NotAnOwnerDeviceError();
  }
  return signStatement(
    "Revocation",
    {
      // SAFETY: target comes from the Gateway's owner device list, which reports formatted keys.
      target_fp: await fingerprint(target.devicePub as Ed25519PublicKey),
      target_kind: "owner_device",
      reason: "revoked from the Control UI",
      root_epoch: ROOT_EPOCH,
      issued_at: Math.floor(Date.now() / 1000),
    },
    signer,
  );
}
