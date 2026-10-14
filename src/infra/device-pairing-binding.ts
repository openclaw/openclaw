import { resolveNodePairingState } from "./device-pairing-identity.js";
import type { DevicePairingBindingFact } from "./device-pairing-read.types.js";
import type { PairedDevice } from "./device-pairing.types.js";

export function prepareDevicePairingBinding(
  deviceId: string,
  device: PairedDevice | null,
): DevicePairingBindingFact {
  const state = resolveNodePairingState(device);
  return {
    deviceId,
    binding: state
      ? {
          identity: state.identity.key,
          ...(state.generation ? { generation: state.generation.key } : {}),
        }
      : null,
  };
}
