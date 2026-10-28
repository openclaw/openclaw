import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";

export async function pairOperatorDeviceFixture(params: {
  identityPath: string;
  scopes: string[];
  tokenScopes: string[];
  clientId: string;
  clientMode: string;
  callerScopes: string[];
}) {
  const identity = loadOrCreateDeviceIdentity({ path: params.identityPath });
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: "operator",
    scopes: params.scopes,
  });
  await approveDevicePairing(pending.request.requestId, { callerScopes: params.callerScopes });
  const issued = await rotateDeviceToken({
    deviceId: identity.deviceId,
    role: "operator",
    scopes: params.tokenScopes,
  });
  return { identity, issued };
}
