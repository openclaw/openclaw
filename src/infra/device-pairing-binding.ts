import {
  isPairedDeviceTokenIdentityCurrent,
  resolveNodePairingState,
  resolvePairedDeviceTokenIdentity,
} from "./device-pairing-identity.js";
import type { DevicePairingBindingFact } from "./device-pairing-read.types.js";
import type { PairedDevice } from "./device-pairing.types.js";

export function prepareDevicePairingBinding(
  deviceId: string,
  device: PairedDevice | null,
): DevicePairingBindingFact {
  const state = resolveNodePairingState(device);
  const operator = resolvePairedDeviceTokenIdentity(device, "operator");
  const operatorToken = device?.tokens?.operator;
  return {
    deviceId,
    operatorBinding:
      operator &&
      operatorToken &&
      isPairedDeviceTokenIdentityCurrent(device, "operator", operator, [])
        ? { identity: operator.key, scopes: [...operatorToken.scopes] }
        : null,
    binding: state
      ? {
          identity: state.identity.key,
          ...(state.generation ? { generation: state.generation.key } : {}),
        }
      : null,
  };
}
