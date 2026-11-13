import { resolveApprovedDeviceScopeBaseline } from "../../infra/device-pairing-identity.js";
import { captureDevicePairingPublication } from "../../infra/device-pairing-publication.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../../infra/device-pairing-store-readonly.js";
import { intersectOperatorScopes } from "../../shared/operator-scope-compat.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { readOperatorProfileEnrollment } from "../operator-device-profile.js";
import type { OperatorProfileEnrollment } from "../operator-device-profile.types.js";
import { isOperatorProfileEnrollmentCurrent } from "../operator-profile-enrollment-authority.js";
import { prepareOpenClawIdOperatorDeviceBindings } from "./device-token-binding.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

/** Resolve a personal HTTP source from the peer's existing host-owned operator bindings. */
export async function resolveOpenClawIdOperatorProfileEnrollment(
  principal: OpenClawIdTunnelPrincipal,
): Promise<{
  enrollment?: Readonly<OperatorProfileEnrollment>;
  scopeCeiling?: readonly string[];
  isCurrent: () => boolean;
}> {
  if (principal.kind === "node") {
    throw new Error("An OpenClaw ID node listing cannot supply a personal operator profile.");
  }
  if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
    throw new Error("OpenClaw ID membership authority changed.");
  }
  const bindings = await prepareOpenClawIdOperatorDeviceBindings(principal);
  if (bindings.deviceIds.length === 0) {
    return {
      isCurrent: () => isOpenClawIdTunnelPrincipalCurrent(principal) && bindings.isCurrent(),
    };
  }
  await Promise.all(bindings.deviceIds.map((id) => loadPairedDevicePairingStoreRecordReadOnly(id)));
  const { admission } = captureOpenClawStateReadContext();
  const publication = captureDevicePairingPublication(admission);
  const assertBindingsCurrent = () => {
    admission.assertCurrent();
    if (!isOpenClawIdTunnelPrincipalCurrent(principal) || !bindings.isCurrent()) {
      throw new Error("OpenClaw ID operator device bindings changed.");
    }
  };
  assertBindingsCurrent();
  const cohort = bindings.deviceIds.map((deviceId) => {
    const device = publication.readDevice(deviceId);
    if (!device) {
      throw new Error("OpenClaw ID operator pairing authority is unavailable.");
    }
    if (device.operatorProfileId !== undefined && !bindings.isOperatorBindingCurrent(deviceId)) {
      throw new Error(
        "OpenClaw ID personal operator binding listing changed; reconnect the signed device.",
      );
    }
    return {
      deviceId,
      enrollment: readOperatorProfileEnrollment(device, {
        role: "operator",
        deviceId,
        publicKey: device.publicKey,
      }),
    };
  });
  const enrollments = cohort.flatMap(({ enrollment }) => (enrollment ? [enrollment] : []));
  const [enrollment] = enrollments;
  // Alias resolution belongs to new admission only. Retained sources keep the raw association.
  const catalog = enrollment ? await prepareUserProfileCatalog() : undefined;
  try {
    const canonicalIds = new Set<string>();
    const ceilings = enrollments.map(({ deviceId, profileId }) => {
      const identity = catalog?.readCurrentIdentity(profileId);
      if (!identity) {
        throw new Error("OpenClaw ID operator profile is unavailable.");
      }
      canonicalIds.add(identity.profileId);
      const device = publication.readDevice(deviceId);
      if (!device) {
        throw new Error("OpenClaw ID operator pairing authority is unavailable.");
      }
      return resolveApprovedDeviceScopeBaseline(device) ?? [];
    });
    if (canonicalIds.size > 1) {
      throw new Error("OpenClaw ID peer has conflicting personal operator enrollments.");
    }
    const scopeCeiling = enrollment
      ? Object.freeze(ceilings.reduce((left, right) => intersectOperatorScopes(left, right)))
      : undefined;
    const isCurrent = () => {
      try {
        assertBindingsCurrent();
        return cohort.every(({ deviceId, enrollment: candidate }) => {
          const device = publication.readDevice(deviceId);
          return candidate
            ? bindings.isOperatorBindingCurrent(deviceId) &&
                isOperatorProfileEnrollmentCurrent(device, candidate, scopeCeiling ?? [])
            : Boolean(device && device.operatorProfileId === undefined);
        });
      } catch {
        return false;
      }
    };
    if (!isCurrent()) {
      throw new Error("OpenClaw ID operator enrollment changed during admission.");
    }
    return {
      enrollment: enrollment ? Object.freeze({ ...enrollment }) : undefined,
      scopeCeiling,
      isCurrent,
    };
  } finally {
    catalog?.release();
  }
}
