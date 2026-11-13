import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  hasEffectivePairedDeviceRole,
  resolveApprovedDeviceScopeBaseline,
} from "../infra/device-pairing-identity.js";
import { captureDevicePairingPublication } from "../infra/device-pairing-publication.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type { OperatorProfileEnrollment } from "./operator-device-profile.types.js";

/** Preserve the approved installation and raw association; only new admission resolves aliases. */
export function isOperatorProfileEnrollmentCurrent(
  device: PairedDevice | null | undefined,
  enrollment: Readonly<OperatorProfileEnrollment>,
  scopes: readonly string[],
): boolean {
  if (
    !device ||
    device.deviceId !== enrollment.deviceId ||
    device.publicKey !== enrollment.publicKey ||
    device.createdAtMs !== enrollment.createdAtMs ||
    device.operatorProfileId !== enrollment.profileId ||
    enrollment.profileId === GATEWAY_OWNER_PROFILE_ID ||
    !hasEffectivePairedDeviceRole(device, "operator")
  ) {
    return false;
  }
  const approvedScopes = resolveApprovedDeviceScopeBaseline(device);
  return (
    approvedScopes !== null &&
    roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: approvedScopes })
  );
}

/** Consume pairing's existing committed publication and physical-store lifetime, never a token successor. */
export function captureOperatorProfileEnrollmentAssertion(
  enrollment: Readonly<OperatorProfileEnrollment>,
  scopes: readonly string[],
): () => void {
  const { admission } = captureOpenClawStateReadContext();
  const publication = captureDevicePairingPublication(admission);
  return () => {
    admission.assertCurrent();
    if (
      !isOperatorProfileEnrollmentCurrent(
        publication.readDevice(enrollment.deviceId),
        enrollment,
        scopes,
      )
    ) {
      throw new Error("Operator device profile enrollment changed; reconnect before continuing.");
    }
  };
}
