import {
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
} from "../infra/device-auth-store.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";

export async function loadStoredOperatorDeviceAuthToken(
  deviceIdentity: DeviceIdentity | null,
  deviceAuthScope?: string,
  sharedStateMode?: "read-only",
): Promise<DeviceAuthEntry | null> {
  if (!deviceIdentity) {
    return null;
  }
  try {
    if (deviceAuthScope) {
      const loadToken =
        sharedStateMode === "read-only" ? loadOriginDeviceTokenReadOnly : loadOriginDeviceToken;
      return await loadToken({
        gatewayScope: deviceAuthScope,
        deviceId: deviceIdentity.deviceId,
        role: "operator",
        env: process.env,
      });
    }
    const loadToken =
      sharedStateMode === "read-only" ? loadDeviceAuthTokenReadOnly : loadDeviceAuthToken;
    return await loadToken({
      deviceId: deviceIdentity.deviceId,
      role: "operator",
      env: process.env,
    });
  } catch {
    return null;
  }
}
