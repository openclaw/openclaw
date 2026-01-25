import type { GatewayBrowserClient } from "../gateway";
import { loadOrCreateDeviceIdentity } from "../device-identity";
import { clearDeviceAuthToken, storeDeviceAuthToken } from "../device-auth";
import { showDangerConfirmDialog } from "../components/confirm-dialog";
import { toast } from "../components/toast";

export type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  createdAtMs?: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

export type PendingDevice = {
  requestId: string;
  deviceId: string;
  displayName?: string;
  role?: string;
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

export type PairedDevice = {
  deviceId: string;
  displayName?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

export type DevicePairingList = {
  pending: PendingDevice[];
  paired: PairedDevice[];
};

export type DevicesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
};

export async function loadDevices(state: DevicesState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) return;
  if (state.devicesLoading) return;
  state.devicesLoading = true;
  if (!opts?.quiet) state.devicesError = null;
  try {
    const res = (await state.client.request("device.pair.list", {})) as DevicePairingList | null;
    state.devicesList = {
      pending: Array.isArray(res?.pending) ? res!.pending : [],
      paired: Array.isArray(res?.paired) ? res!.paired : [],
    };
  } catch (err) {
    if (!opts?.quiet) state.devicesError = String(err);
  } finally {
    state.devicesLoading = false;
  }
}

export async function approveDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) return;
  try {
    await state.client.request("device.pair.approve", { requestId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function rejectDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) return;
  const confirmed = await showDangerConfirmDialog(
    "Reject Device",
    "Reject this device pairing request?",
    "Reject",
  );
  if (!confirmed) return;
  try {
    await state.client.request("device.pair.reject", { requestId });
    toast.success("Device pairing rejected");
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
    toast.error("Failed to reject device");
  }
}

export async function rotateDeviceToken(
  state: DevicesState,
  params: { deviceId: string; role: string; scopes?: string[] },
) {
  if (!state.client || !state.connected) return;
  try {
    const res = (await state.client.request("device.token.rotate", params)) as
      | { token?: string; role?: string; deviceId?: string; scopes?: string[] }
      | undefined;
    if (res?.token) {
      const identity = await loadOrCreateDeviceIdentity();
      const role = res.role ?? params.role;
      if (res.deviceId === identity.deviceId || params.deviceId === identity.deviceId) {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          role,
          token: res.token,
          scopes: res.scopes ?? params.scopes ?? [],
        });
      }
      window.prompt("New device token (copy and store securely):", res.token);
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function revokeDeviceToken(
  state: DevicesState,
  params: { deviceId: string; role: string },
) {
  if (!state.client || !state.connected) return;
  const confirmed = await showDangerConfirmDialog(
    "Revoke Token",
    `Revoke token for ${params.deviceId} (${params.role})? This action cannot be undone.`,
    "Revoke",
  );
  if (!confirmed) return;
  try {
    await state.client.request("device.token.revoke", params);
    const identity = await loadOrCreateDeviceIdentity();
    if (params.deviceId === identity.deviceId) {
      clearDeviceAuthToken({ deviceId: identity.deviceId, role: params.role });
    }
    toast.success("Token revoked");
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
    toast.error("Failed to revoke token");
  }
}
