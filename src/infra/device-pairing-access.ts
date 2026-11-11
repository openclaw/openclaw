import type { PairedDeviceMetadataPatch } from "./device-pairing-core.types.js";
import type { PairedDevice } from "./device-pairing.types.js";

export type DevicePairingAccessIdentity = Pick<PairedDevice, "publicKey" | "approvedAtMs">;

/** Last-seen time/reason may lag by a minute; changed metadata is always recorded. */
export function preparePairedDeviceAccessPatch(
  device: PairedDevice,
  patch: Partial<PairedDeviceMetadataPatch>,
): Partial<PairedDeviceMetadataPatch> | undefined {
  const metadataChanged = (
    ["displayName", "operatorLabel", "platform", "clientId", "clientMode", "remoteIp"] as const
  ).some((key) => key in patch && device[key] !== patch[key]);
  if (
    !metadataChanged &&
    (patch.lastSeenAtMs === undefined || patch.lastSeenAtMs - (device.lastSeenAtMs ?? 0) < 60_000)
  ) {
    return undefined;
  }
  return patch;
}
