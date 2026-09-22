import type { DeviceIdentity } from "./device-identity-store.js";
import { pruneMapToMaxSize } from "./map-size.js";

const identities = new Map<string, DeviceIdentity>();
const MAX_PROCESS_DEVICE_IDENTITIES = 32;

export function readProcessDeviceIdentity(cacheKey: string): DeviceIdentity | undefined {
  return identities.get(cacheKey);
}

export function cacheProcessDeviceIdentity(
  cacheKey: string,
  identity: DeviceIdentity,
): DeviceIdentity {
  const cached = identities.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneMapToMaxSize(identities, MAX_PROCESS_DEVICE_IDENTITIES - 1);
  identities.set(cacheKey, identity);
  return identity;
}
