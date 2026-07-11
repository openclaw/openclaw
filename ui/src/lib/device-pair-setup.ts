// Shared mobile pairing setup state for app-level entry points.
import type { DevicePairSetupCodeResult } from "../../../packages/gateway-protocol/src/index.js";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type DevicePairSetup = DevicePairSetupCodeResult;

export type DevicePairSetupState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  devicePairSetupOpen: boolean;
  devicePairSetupLoading: boolean;
  devicePairSetupError: string | null;
  devicePairSetup: DevicePairSetup | null;
};

const devicePairSetupRequests = new WeakMap<DevicePairSetupState, object>();

export async function openDevicePairSetup(state: DevicePairSetupState) {
  state.devicePairSetupOpen = true;
  await refreshDevicePairSetup(state);
}

export async function refreshDevicePairSetup(state: DevicePairSetupState) {
  const client = state.client;
  if (!client || !state.connected || state.devicePairSetupLoading) {
    return;
  }
  const requestToken = {};
  devicePairSetupRequests.set(state, requestToken);
  state.devicePairSetupLoading = true;
  state.devicePairSetupError = null;
  try {
    const result = await client.request<DevicePairSetup>("device.pair.setupCode", {});
    if (
      devicePairSetupRequests.get(state) !== requestToken ||
      state.client !== client ||
      !state.connected ||
      !state.devicePairSetupOpen
    ) {
      return;
    }
    state.devicePairSetup = result;
  } catch (err) {
    if (
      devicePairSetupRequests.get(state) === requestToken &&
      state.client === client &&
      state.devicePairSetupOpen
    ) {
      state.devicePairSetupError = String(err);
    }
  } finally {
    // A retired request must not clear the loading state of a replacement request.
    if (devicePairSetupRequests.get(state) === requestToken) {
      devicePairSetupRequests.delete(state);
      state.devicePairSetupLoading = false;
    }
  }
}

export function closeDevicePairSetup(state: DevicePairSetupState) {
  devicePairSetupRequests.delete(state);
  state.devicePairSetupOpen = false;
  state.devicePairSetupLoading = false;
  state.devicePairSetupError = null;
  state.devicePairSetup = null;
}
