import type { PairedDeviceTokenIdentity } from "../infra/device-pairing-core.types.js";
// HTTP bearer admission retains the exact paired credential and its personal enrollment.
import {
  resolveAuthenticatedDeviceTokenIdentity,
  isPairedDeviceTokenIdentityCurrent,
} from "../infra/device-pairing-identity.js";
import { captureDevicePairingPublication } from "../infra/device-pairing-publication.js";
import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { checkDeviceTokenPeer } from "./openclaw-id/device-token-binding.js";
import { readOperatorProfileEnrollment } from "./operator-device-profile.js";
import type { OperatorProfileEnrollment } from "./operator-device-profile.types.js";

export type AdmittedHttpOperatorDevice = {
  scopes: string[];
  identity: PairedDeviceTokenIdentity;
  enrollment?: OperatorProfileEnrollment;
  isCurrent: () => boolean;
};

/** The paired token is bearer authority, never proof of the presenting browser key. */
export async function verifyHttpOperatorDeviceToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
  requiredScopes: readonly string[] = [],
  matchedDeviceId?: string,
): Promise<AdmittedHttpOperatorDevice | null> {
  // Revalidation selects the host's already matched installation, never scans
  // again or guesses a successor when that exact record has disappeared.
  const matched = matchedDeviceId !== undefined ? await getPairedDevice(matchedDeviceId) : null;
  const devices =
    matchedDeviceId !== undefined ? (matched ? [matched] : []) : (await listDevicePairing()).paired;
  for (const device of devices) {
    const operatorToken = device.tokens?.operator;
    if (
      !operatorToken ||
      operatorToken.revokedAtMs ||
      !verifyPairingToken(token, operatorToken.token)
    ) {
      continue;
    }
    const readScope = operatorScopeSatisfied("operator.read", operatorToken.scopes)
      ? "operator.read"
      : "operator.sessions.read";
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: "operator",
      scopes: [readScope, ...operatorToken.scopes, ...requiredScopes],
      requiredSharedGatewaySessionGeneration,
    });
    // Tunnel-issued tokens cannot escape their admitted peer through ordinary HTTP.
    const peer = await checkDeviceTokenPeer({
      deviceId: device.deviceId,
      role: "operator",
      peerKey: undefined,
    });
    if (!verified.ok || !peer.ok) {
      return null;
    }
    const context = captureOpenClawStateWorkerContext({});
    const publication = captureDevicePairingPublication(context.admission);
    const current = publication.readDevice(device.deviceId);
    const identity = resolveAuthenticatedDeviceTokenIdentity(current ?? null, {
      role: "operator",
      publicKey: device.publicKey,
      token,
      scopes: operatorToken.scopes,
    });
    if (!identity) {
      return null;
    }
    const enrollment = readOperatorProfileEnrollment(current ?? null, {
      role: "operator",
      deviceId: device.deviceId,
      publicKey: device.publicKey,
    });
    const isCurrent = () => {
      try {
        context.admission.assertCurrent();
        const live = publication.readDevice(device.deviceId);
        return (
          live !== undefined &&
          isPairedDeviceTokenIdentityCurrent(live, "operator", identity, operatorToken.scopes)
        );
      } catch {
        return false;
      }
    };
    return isCurrent()
      ? { scopes: [...operatorToken.scopes], identity, enrollment, isCurrent }
      : null;
  }
  return null;
}
