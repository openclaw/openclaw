import {
  requestDevicePairing,
  withPairedDeviceRecords,
  type PairedDevice,
} from "./device-pairing.js";

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

export function requestPairing(
  request: Partial<Parameters<typeof requestDevicePairing>[0]>,
  stateDir: string,
) {
  return requestDevicePairing(
    { deviceId: "device-1", publicKey: "public-key-1", ...request },
    stateDir,
  );
}

export async function mutatePairedDevice(
  stateDir: string,
  deviceId: string,
  mutate: (device: PairedDevice) => void,
) {
  await withPairedDeviceRecords(stateDir, (pairedByDeviceId) => {
    const device = requireValue(pairedByDeviceId[deviceId], `expected paired device ${deviceId}`);
    mutate(device);
    return { value: undefined, persist: true };
  });
}
