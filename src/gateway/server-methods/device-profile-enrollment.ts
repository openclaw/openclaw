import {
  ErrorCodes,
  errorShape,
  type DeviceProfileEnrollParams,
  validateDeviceProfileEnrollParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { normalizeDevicePublicKeyBase64Url } from "../../infra/device-identity.js";
import {
  listApprovedPairedDeviceRoles,
  resolveAuthenticatedDeviceTokenIdentity,
} from "../../infra/device-pairing-identity.js";
import { getPairedDevice } from "../../infra/device-pairing.js";
import { enrollDeviceProfile } from "../../infra/device-profile-enrollment.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureCanonicalLocalUserProfile } from "../../state/user-profile-writes.js";
import { retireDeviceTokenClients } from "../device-token-client-lifecycle.js";
import { hasOpenClawIdOperatorBinding } from "../openclaw-id/device-token-binding.js";
import { isOpenClawIdTunnelPrincipalCurrent } from "../openclaw-id/tunnel-principal.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayClient, GatewayRequestHandler } from "./types.js";
import { preparePersonalDeviceAdministration } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

function hasVerifiedProfileSource(client: GatewayClient | null): boolean {
  return Boolean(
    client?.authenticatedUserId ||
    client?.authenticatedGitHubAccountId ||
    client?.authenticatedGitHubIdentitySync ||
    client?.authenticatedUserIsTailscaleProvider ||
    client?.internal?.openclawIdPrincipal?.kind === "member" ||
    client?.internal?.remoteIngressPrincipal?.operatorRoleActor.kind === "operator",
  );
}

export const deviceProfileEnrollHandler: GatewayRequestHandler = async (options) => {
  const { params, client, context, respond } = options;
  if (
    !assertValidParams<DeviceProfileEnrollParams>(
      params,
      validateDeviceProfileEnrollParams,
      "device.profile.enroll",
      respond,
    )
  ) {
    return;
  }
  try {
    const sourceProfileId = client?.authenticatedUserProfile?.profileId;
    const sourceDeviceId = client?.connect.device?.id.trim();
    const admittedDevice = client?.internal?.operatorDeviceTokenIdentity;
    const deviceId = params.deviceId?.trim() || sourceDeviceId;
    const selectedProfileId = params.profileId?.trim();
    if (
      !deviceId ||
      Boolean(selectedProfileId) === Boolean(params.enrollmentId) ||
      (selectedProfileId && params.name !== undefined)
    ) {
      throw new Error(
        "Choose exactly one of profileId or enrollmentId; deviceId is required without an authenticated device",
      );
    }
    if (selectedProfileId === GATEWAY_OWNER_PROFILE_ID) {
      throw new Error("SharedOwner cannot be a personal enrollment target");
    }
    const assertAdmin = await preparePersonalDeviceAdministration(options);
    const assertSource = () => {
      assertAdmin();
      const idPrincipal = client?.internal?.openclawIdPrincipal;
      if (idPrincipal && !isOpenClawIdTunnelPrincipalCurrent(idPrincipal)) {
        throw new Error("OpenClaw ID membership changed during enrollment");
      }
      const principal = client?.internal?.remoteIngressPrincipal;
      principal?.signal.throwIfAborted();
      principal?.assertCurrent();
      if (principal && principal.authenticatedUserProfile.profileId !== sourceProfileId) {
        throw new Error("Enrollment requester identity source changed");
      }
      if (
        !client ||
        !sourceProfileId ||
        client.connect.role !== "operator" ||
        (client.internal?.operatorRoleActor?.kind === "system" &&
          sourceProfileId !== GATEWAY_OWNER_PROFILE_ID) ||
        client.connectionSignal?.aborted ||
        client.invalidated ||
        client.connect.device?.id.trim() !== sourceDeviceId
      ) {
        throw new Error("Enrollment requires a current authenticated operator administrator");
      }
    };
    assertSource();
    // A verified ingress identity cannot be replaced by a local display-name enrollment.
    const verifiedSource = hasVerifiedProfileSource(client);
    const pairingContext = captureOpenClawStateWorkerContext();
    const assertTargetSource = (profileId?: string) => {
      pairingContext.admission.assertCurrent();
      assertSource();
      const conflictingConnections = context.getClientConnIds?.(
        (current) =>
          !current.invalidated &&
          !current.connectionSignal?.aborted &&
          current.internal?.authenticatedOperator === true &&
          !isSyntheticGatewayCaller(current) &&
          current.connect.device?.id.trim() === deviceId &&
          hasVerifiedProfileSource(current) &&
          current.authenticatedUserProfile?.profileId !== profileId,
      );
      if (
        (conflictingConnections?.size ?? 0) > 0 ||
        (deviceId === sourceDeviceId && verifiedSource && sourceProfileId !== profileId) ||
        (hasOpenClawIdOperatorBinding(deviceId) &&
          !(
            deviceId === sourceDeviceId && client?.internal?.openclawIdPrincipal?.kind === "owner"
          ) &&
          (deviceId !== sourceDeviceId || sourceProfileId !== profileId))
      ) {
        throw new Error("Enrollment conflicts with the device's verified identity source");
      }
    };
    assertTargetSource(selectedProfileId);
    const device = await getPairedDevice(deviceId);
    assertTargetSource(selectedProfileId);
    if (
      !device ||
      !listApprovedPairedDeviceRoles(device).includes("operator") ||
      !device.tokens?.operator ||
      device.tokens.operator.revokedAtMs !== undefined
    ) {
      throw new Error("Enrollment requires an approved active operator device");
    }
    const expectedOperator = resolveAuthenticatedDeviceTokenIdentity(device, {
      role: "operator",
      publicKey: device.publicKey,
      token: device.tokens.operator.token,
      scopes: device.tokens.operator.scopes,
    });
    if (
      deviceId === sourceDeviceId &&
      (normalizeDevicePublicKeyBase64Url(client?.connect.device?.publicKey ?? "") !==
        device.publicKey ||
        (admittedDevice &&
          (admittedDevice.deviceId !== expectedOperator?.deviceId ||
            admittedDevice.key !== expectedOperator?.key)))
    ) {
      throw new Error("The enrolled installation changed after this connection was admitted");
    }
    if (!expectedOperator) {
      throw new Error("Enrollment requires a current approved operator grant");
    }
    let profileId = selectedProfileId;
    if (!profileId) {
      if (!params.enrollmentId) {
        throw new Error("Local enrollment requires enrollmentId");
      }
      profileId = (
        await ensureCanonicalLocalUserProfile(
          { enrollmentId: params.enrollmentId, name: params.name },
          {
            path: pairingContext.admission.databasePath,
            env: pairingContext.environment,
            assertCurrent: () => assertTargetSource(),
          },
        )
      ).id;
    }
    const enrolledProfileId = profileId;
    assertTargetSource(profileId);
    if (deviceId === sourceDeviceId) {
      holdGatewayPolicyResponse(respond);
    }
    const result = await enrollDeviceProfile(
      { deviceId, profileId, expectedOperator },
      {
        context: pairingContext,
        assertCurrent: () => assertTargetSource(enrolledProfileId),
        onTokensReplaced: (replacedDeviceId, roles) => {
          retireDeviceTokenClients(context, replacedDeviceId, roles, "device-token-rotated");
        },
      },
    );
    // A replacing publication intentionally retires this source; its held reply owns delivery.
    if (!result.replaced || deviceId !== sourceDeviceId) {
      assertTargetSource(profileId);
    }
    respond(
      true,
      {
        deviceId: result.deviceId,
        profileId: result.profileId,
        ...(deviceId === sourceDeviceId
          ? {
              operatorToken: {
                token: result.operatorToken.token,
                scopes: result.operatorToken.scopes,
              },
            }
          : {}),
      },
      undefined,
    );
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
  }
};
