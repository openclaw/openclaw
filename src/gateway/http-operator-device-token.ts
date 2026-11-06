// Device-token fallback for HTTP operator auth: a bearer token may be a paired
// device's Control UI operator token instead of the shared Gateway credential.
import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { checkDeviceTokenPeer } from "./openclaw-id/device-token-binding.js";

const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read.no-credential-enrollment";
const CONTROL_UI_OPERATOR_ROLE = "operator";

/**
 * Returns the scopes of the paired device whose Control UI operator token matches
 * `token`, or null when none matches, verification fails or the token is bound
 * to an OpenClaw ID tunnel peer.
 */
export async function verifyHttpOperatorDeviceToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
  requiredScopes: readonly string[] = [],
): Promise<string[] | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      !operatorToken ||
      operatorToken.revokedAtMs ||
      !verifyPairingToken(token, operatorToken.token)
    ) {
      continue;
    }
    const readScope = operatorScopeSatisfied(CONTROL_UI_OPERATOR_READ_SCOPE, operatorToken.scopes)
      ? CONTROL_UI_OPERATOR_READ_SCOPE
      : "operator.sessions.read";
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      // Verify the whole observed grant so a concurrent scope reduction cannot
      // leave the HTTP request with authority from the earlier pairing snapshot.
      scopes: [readScope, ...operatorToken.scopes, ...requiredScopes],
      requiredSharedGatewaySessionGeneration,
    });
    // HTTP fallback is ordinary ingress only; tunnel-bound tokens cannot escape their peer.
    const identity = { deviceId: device.deviceId, role: CONTROL_UI_OPERATOR_ROLE };
    const peer = await checkDeviceTokenPeer({ ...identity, peerKey: undefined });
    return verified.ok && peer.ok ? [...operatorToken.scopes] : null;
  }
  return null;
}
