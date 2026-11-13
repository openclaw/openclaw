import { storeDeviceAuthToken } from "../lib/nodes/index.ts";
import type { GatewayBrowserClient } from "./gateway.ts";

export type ProfileEnrollmentParams = {
  deviceId?: string;
  profileId?: string;
  enrollmentId?: string;
  name?: string;
};

/** The signed connection owns credential adoption; renderers never see or store bearer tokens. */
export async function enrollGatewayProfile(
  client: GatewayBrowserClient,
  params: ProfileEnrollmentParams,
) {
  const enrollment = client.profileEnrollment;
  const hello = client.hello;
  if (!client.connected || !hello) {
    throw new Error(
      "Personal setup requires a connected operator device. Reconnect and try again.",
    );
  }
  const native = enrollment.native;
  if (native) {
    if (!enrollment.signal || !native.enrollProfile) {
      throw new Error("Reconnect the native app to finish personal setup.");
    }
    return native.enrollProfile(params, enrollment.signal);
  }
  const deviceId = enrollment.deviceId;
  if (!deviceId) {
    throw new Error("Personal setup requires a signed browser device. Reconnect and try again.");
  }
  const result = await client.request<{
    deviceId: string;
    profileId: string;
    operatorToken?: { token: string; scopes: string[] };
  }>("device.profile.enroll", params);
  if (
    !client.connected ||
    client.hello !== hello ||
    client.profileEnrollment?.deviceId !== deviceId
  ) {
    throw new Error(
      "The connection changed during personal setup. Reconnect and check your profile before retrying.",
    );
  }
  if (result.operatorToken) {
    if (result.deviceId !== deviceId) {
      throw new Error(
        "Personal setup returned a credential for another device. Reconnect and check your profile.",
      );
    }
    storeDeviceAuthToken({
      deviceId,
      gatewayUrl: client.gatewayUrl,
      role: "operator",
      ...result.operatorToken,
    });
  }
  return {
    deviceId: result.deviceId,
    profileId: result.profileId,
    reconnect: Boolean(result.operatorToken),
  };
}
