import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { OperatorProfileEnrollment } from "./operator-device-profile.types.js";
import { isOperatorProfileEnrollmentCurrent } from "./operator-profile-enrollment-authority.js";

/** Only an approved operator installation can supply its mandatory personal identity. */
export function readOperatorProfileEnrollment(
  device: PairedDevice | null,
  source: { role: string; deviceId: string; publicKey: string; allowReapproval?: boolean },
): OperatorProfileEnrollment | undefined {
  if (
    source.role !== "operator" ||
    !device ||
    device.operatorProfileId === undefined ||
    device.deviceId !== source.deviceId ||
    device.publicKey !== source.publicKey
  ) {
    return undefined;
  }
  const enrollment = {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    createdAtMs: device.createdAtMs,
    profileId: device.operatorProfileId,
  };
  if (
    device.operatorProfileId === GATEWAY_OWNER_PROFILE_ID ||
    (!source.allowReapproval && !isOperatorProfileEnrollmentCurrent(device, enrollment, []))
  ) {
    throw new Error("Personal operator enrollment is no longer active; enroll this device again.");
  }
  return enrollment;
}
