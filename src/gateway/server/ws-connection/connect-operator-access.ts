import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { gatewayOperatorAccessError } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { prepareDeviceBootstrapProfileAuthority } from "../../../infra/device-bootstrap-profile-authority.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../../../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../../../infra/device-pairing-store-readonly.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import { deviceBootstrapProfilesEqual } from "../../../shared/device-bootstrap-profile.js";
import { intersectOperatorScopes } from "../../../shared/operator-scope-compat.js";
import { isOperatorAuthorityUnavailable } from "../../../infra/operator-authority-error.js";
import { errorShapeFromError } from "../../error-shape.js";
import {
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "../../operator-access-policy.js";
import { readOperatorProfileEnrollment } from "../../operator-device-profile.js";
import { invalidateGatewayPolicyClient } from "../ws-policy-close.js";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveGatewayConnectPolicyFailure } from "./connect-admission.js";
import { resolvePairedAccessScopes } from "./connect-device-metadata.js";
import type {
  AuthenticatedGatewayConnect,
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

export function prepareGatewayConnectOperatorAccess(client: GatewayWsClient): void {
  if (client.connect.role !== "operator" || client.internal?.operatorRoleActor?.kind === "system") {
    return;
  }
  const profile = client.authenticatedUserProfile;
  const config = getRuntimeConfig();
  if (hasGatewayOperatorAccessPolicies(config) && !profile) {
    throw new GatewayOperatorAccessDeniedError("profile-invalidated");
  }
  const operatorAccessAuthority = profile
    ? resolveGatewayOperatorAccessAuthority(profile.profileId, config)
    : undefined;
  if (operatorAccessAuthority !== undefined) {
    client.internal = { ...client.internal, operatorAccessAuthority };
  }
}

export async function rejectGatewayConnectOperatorAccess(
  context: GatewayConnectPhaseContext,
  error: unknown,
): Promise<void> {
  if (isOperatorAuthorityUnavailable(error)) {
    const unavailable = errorShapeFromError(ErrorCodes.UNAVAILABLE, error);
    context.markHandshakeFailure("operator-access-unavailable", {});
    context.sendHandshakeErrorResponse(ErrorCodes.UNAVAILABLE, unavailable.message, unavailable);
    await context.releasePendingNodePairingCleanup();
    context.handler.close(1013, unavailable.message);
    return;
  }
  const denial = gatewayOperatorAccessError(
    error instanceof GatewayOperatorAccessDeniedError ? error.accessCause : "profile-invalidated",
  );
  context.markHandshakeFailure("operator-access-denied", {
    accessCause: denial.details.accessCause,
  });
  context.sendHandshakeErrorResponse(ErrorCodes.FORBIDDEN, denial.message, denial);
  await context.releasePendingNodePairingCleanup();
  context.handler.close(1008, denial.message);
}

/** Attach only this connection to the grant; disconnect never closes the retained authority. */
export function bindGatewayConnectOperatorAccess(
  context: GatewayConnectPhaseContext,
  client: GatewayWsClient,
): boolean {
  const authority = client.internal?.operatorAccessAuthority;
  if (!authority) {
    return true;
  }
  const revoke = () => {
    const denial = gatewayOperatorAccessError(authority.failureCause ?? "policy-check-failed");
    context.handler.setCloseCause("operator-access-closed", {
      accessCause: denial.details.accessCause,
    });
    invalidateGatewayPolicyClient(client, {
      reason: "operator-access-closed",
      code: 4001,
      message: denial.message,
      close: () => context.handler.close(4001, denial.message),
    });
  };
  // Socket retirement releases only its listener. Accepted work keeps the same
  // grant signal through its existing request/run owner.
  const release = () => authority.signal.removeEventListener("abort", revoke);
  client.socket.once("close", release);
  authority.signal.addEventListener("abort", revoke, { once: true });
  if (authority.signal.aborted) {
    revoke();
    return false;
  }
  return true;
}

/** Capture the accepted credential before any run can retain this connection's authority. */
export async function prepareGatewayConnectOperatorDeviceSource(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
  scopes: readonly string[],
) {
  const { device, devicePublicKey, deviceToken, authMethod } = state;
  const token =
    authMethod === "device-token"
      ? normalizeOptionalString(
          context.connectParams.auth?.deviceToken ?? context.connectParams.auth?.token,
        )
      : deviceToken?.token;
  const paired =
    device && devicePublicKey ? await loadPairedDevicePairingStoreRecordReadOnly(device.id) : null;
  const enrollmentCurrent =
    !state.operatorProfileEnrollment ||
    Boolean(
      device &&
      devicePublicKey &&
      isDeepStrictEqual(
        state.operatorProfileEnrollment,
        readOperatorProfileEnrollment(paired, {
          role: "operator",
          deviceId: device.id,
          publicKey: devicePublicKey,
        }),
      ),
    );
  const identity =
    device && devicePublicKey && token
      ? resolveAuthenticatedDeviceTokenIdentity(paired, {
          role: "operator",
          publicKey: devicePublicKey,
          token,
          scopes,
        })
      : null;
  // Shared/proxy identity can be tokenless. A token-bearing handshake cannot
  // bind to a replacement credential discovered while preparation yielded.
  if (!enrollmentCurrent || (token && !identity)) {
    context.markHandshakeFailure("operator-pairing-generation-changed");
    context.sendHandshakeErrorResponse(
      ErrorCodes.NOT_PAIRED,
      "device pairing changed during connect",
    );
    await context.releasePendingNodePairingCleanup();
    context.handler.close(1008, "device pairing changed during connect");
    return undefined;
  }
  return identity;
}

/** Resolve the personal installation before pairing; the existing owners retain all authority. */
export async function prepareGatewayConnectDeviceEnrollment(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
) {
  const { role, device, devicePublicKey, authMethod } = state;
  let { scopes } = state;
  let bootstrapAuthority:
    | Awaited<ReturnType<typeof prepareDeviceBootstrapProfileAuthority>>
    | undefined;
  const isCurrent = () => {
    try {
      if (bootstrapAuthority) {
        bootstrapAuthority.assertCurrent();
        return true;
      }
      return resolveGatewayConnectPolicyFailure(context, state) === undefined;
    } catch {
      return false;
    }
  };
  const personalBootstrap =
    authMethod === "bootstrap-token" &&
    state.issuedBootstrapProfile?.operatorProfileId !== undefined
      ? state.issuedBootstrapProfile
      : undefined;
  if (personalBootstrap) {
    try {
      bootstrapAuthority = await prepareDeviceBootstrapProfileAuthority(personalBootstrap, {
        assertCurrent: () => {
          if (resolveGatewayConnectPolicyFailure(context, state) !== undefined) {
            throw new Error("Bootstrap connection authority changed");
          }
        },
      });
      if (!deviceBootstrapProfilesEqual(personalBootstrap, bootstrapAuthority.profile)) {
        throw new Error("Bootstrap person role no longer permits the issued grant");
      }
    } catch {
      return {
        ok: false as const,
        message: "Personal bootstrap is no longer authorized; request a fresh handoff.",
      };
    }
  }
  const operatorDevice =
    role === "operator" && device && devicePublicKey ? await getPairedDevice(device.id) : null;
  let operatorProfileEnrollment: ReturnType<typeof readOperatorProfileEnrollment>;
  try {
    operatorProfileEnrollment =
      device && devicePublicKey
        ? readOperatorProfileEnrollment(operatorDevice, {
            role,
            deviceId: device.id,
            publicKey: devicePublicKey,
            // Only a verified handoff can reach the existing reapproval ceremony.
            allowReapproval: authMethod === "bootstrap-token",
          })
        : undefined;
  } catch {
    return {
      ok: false as const,
      message: "Personal device enrollment is inactive; request enrollment again.",
    };
  }
  if (
    operatorProfileEnrollment &&
    personalBootstrap &&
    operatorProfileEnrollment.profileId !== personalBootstrap.operatorProfileId
  ) {
    return {
      ok: false as const,
      message:
        "This device represents another person; use explicit profile enrollment to change it.",
    };
  }
  if (operatorProfileEnrollment && operatorDevice && authMethod !== "bootstrap-token") {
    // Shared or ingress authority cannot silently widen a personal installation.
    scopes = intersectOperatorScopes(scopes, resolvePairedAccessScopes(operatorDevice));
  }
  return {
    ok: true as const,
    scopes,
    operatorDevice,
    operatorProfileEnrollment,
    personalBootstrap,
    isCurrent,
  };
}
