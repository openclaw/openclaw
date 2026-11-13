import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertDeviceBootstrapPersonalSelection,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { selectResolvedUserProfileById } from "../state/user-profiles-internal.js";
import type { PairedDeviceTokenIdentity } from "./device-pairing-core.types.js";
import { isPairedDeviceTokenIdentityCurrent } from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import { updatePairedDeviceInTransaction } from "./device-pairing-store.js";
import { createDeviceAuthToken } from "./device-pairing-token-utils.js";
import type { DeviceAuthToken } from "./device-pairing.types.js";
import type { EngineConnection } from "./sql-connection.js";

export type DeviceProfileEnrollmentResult = {
  deviceId: string;
  profileId: string;
  operatorToken: DeviceAuthToken;
  replaced: boolean;
};

/** The profile owner resolves aliases; an enrollment selection must still name its exact live head. */
export function assertPersonalOperatorEnrollmentProfile(
  db: EngineConnection,
  profileId: string,
): void {
  const profile = selectResolvedUserProfileById(db, profileId);
  if (
    !profile ||
    profile.id !== profileId ||
    profile.merged_into ||
    profile.id === GATEWAY_OWNER_PROFILE_ID
  ) {
    throw new Error("Enrollment requires a current personal profile");
  }
}

/** Bootstrap grants use the same exact person check, plus their attended-purpose contract. */
export function assertBootstrapPersonInDatabase(
  db: EngineConnection,
  profile: DeviceBootstrapProfile,
): void {
  assertDeviceBootstrapPersonalSelection(profile);
  if (profile.operatorProfileId !== undefined) {
    assertPersonalOperatorEnrollmentProfile(db, profile.operatorProfileId);
  }
}

/** The approved operator grant and exact profile are read under the pairing write lock. */
export function enrollDeviceProfileInWorker(
  db: EngineConnection,
  input: {
    deviceId: string;
    profileId: string;
    expectedOperator: PairedDeviceTokenIdentity;
    nowMs: number;
  },
): DeviceProfileEnrollmentResult {
  assertPersonalOperatorEnrollmentProfile(db, input.profileId);
  return updatePairedDeviceInTransaction<DeviceProfileEnrollmentResult>(
    input.deviceId,
    (device) => {
      const existing = device?.tokens?.operator;
      if (
        !device ||
        !existing ||
        existing.revokedAtMs !== undefined ||
        !isPairedDeviceTokenIdentityCurrent(
          device,
          "operator",
          input.expectedOperator,
          existing.scopes,
        )
      ) {
        throw new Error("Enrollment requires an approved active operator device");
      }
      requestDevicePairingMutationAdmission({
        kind: "pairing-profile-enrollment",
        deviceId: input.deviceId,
        profileId: input.profileId,
      });
      const replaced = device.operatorProfileId !== input.profileId;
      const token = replaced
        ? createDeviceAuthToken({
            role: "operator",
            scopes: existing.scopes,
            existing,
            preserveExistingIssuer: true,
            now: input.nowMs,
            rotatedAtMs: input.nowMs,
          })
        : existing;
      return {
        value: {
          deviceId: device.deviceId,
          profileId: input.profileId,
          operatorToken: token,
          replaced,
        },
        patch: replaced
          ? { operatorProfileId: input.profileId, tokens: { ...device.tokens, operator: token } }
          : undefined,
      };
    },
  );
}
