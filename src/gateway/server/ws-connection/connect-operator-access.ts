import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../../../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../../../infra/device-pairing-store-readonly.js";
import {
  GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "../../operator-access-policy.js";
import { invalidateGatewayPolicyClient } from "../ws-policy-close.js";
import type { GatewayWsClient } from "../ws-types.js";
import type {
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
    throw new GatewayOperatorAccessDeniedError();
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
): Promise<void> {
  context.markHandshakeFailure("operator-access-denied");
  context.sendHandshakeErrorResponse(ErrorCodes.FORBIDDEN, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE, {
    details: { code: ConnectErrorDetailCodes.OPERATOR_ACCESS_DENIED },
  });
  await context.releasePendingNodePairingCleanup();
  context.handler.close(1008, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
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
    context.handler.setCloseCause("operator-access-closed");
    invalidateGatewayPolicyClient(client, {
      reason: "operator-access-closed",
      code: 4001,
      message: GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
      close: () => context.handler.close(4001, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE),
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
  const identity =
    device && devicePublicKey && token
      ? resolveAuthenticatedDeviceTokenIdentity(
          await loadPairedDevicePairingStoreRecordReadOnly(device.id),
          { role: "operator", publicKey: devicePublicKey, token, scopes },
        )
      : null;
  // Shared/proxy identity can be tokenless. A token-bearing handshake cannot
  // bind to a replacement credential discovered while preparation yielded.
  if (token && !identity) {
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
