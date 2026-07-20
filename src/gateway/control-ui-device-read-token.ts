// Shared authorization for Control UI device read tokens.
// Control UI read surfaces (config bootstrap, assistant media, and the webchat
// managed outgoing-image route) accept a paired operator.read device token as
// the read credential a browser tab actually holds. This module owns that
// verification plus its generation/scope semantics so the surfaces cannot
// diverge.
import { listDevicePairing, verifyDeviceToken } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";

const CONTROL_UI_OPERATOR_ROLE = "operator";
const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";

async function verifyControlUiDeviceReadToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
): Promise<boolean> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (!operatorToken || operatorToken.revokedAtMs) {
      continue;
    }
    if (!verifyPairingToken(token, operatorToken.token)) {
      continue;
    }
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [CONTROL_UI_OPERATOR_READ_SCOPE],
      requiredSharedGatewaySessionGeneration,
    });
    if (verified.ok) {
      return true;
    }
  }
  return false;
}

async function resolveControlUiDeviceReadTokenScopes(token: string): Promise<string[] | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorBearer = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      operatorBearer &&
      !operatorBearer.revokedAtMs &&
      verifyPairingToken(token, operatorBearer.token)
    ) {
      return operatorBearer.scopes;
    }
  }
  return null;
}

export type ControlUiDeviceReadTokenAuth =
  | { ok: true; scopes: string[] }
  | { ok: false; rateLimited: true; retryAfterMs: number }
  | { ok: false; rateLimited: false };

/**
 * Verify a Control UI operator.read device token, applying the device-token
 * rate-limit scope. On success both credential-class counters are reset so a
 * successful device read clears any shared-secret failures the same tab
 * accumulated during login.
 */
export async function authorizeControlUiDeviceReadTokenRequest(params: {
  token: string;
  requiredSharedGatewaySessionGeneration: string | undefined;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}): Promise<ControlUiDeviceReadTokenAuth> {
  const rateCheck = params.rateLimiter?.check(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
  if (rateCheck && !rateCheck.allowed) {
    return { ok: false, rateLimited: true, retryAfterMs: rateCheck.retryAfterMs };
  }
  const verified = await verifyControlUiDeviceReadToken(
    params.token,
    params.requiredSharedGatewaySessionGeneration,
  );
  const scopes = verified ? await resolveControlUiDeviceReadTokenScopes(params.token) : null;
  if (scopes) {
    params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    return { ok: true, scopes };
  }
  params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
  return { ok: false, rateLimited: false };
}
