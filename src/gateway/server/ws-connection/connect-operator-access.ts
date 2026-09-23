import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/io.js";
import {
  GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE,
  GatewayOperatorAccessDeniedError,
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
} from "../../operator-access-policy.js";
import { invalidateGatewayPolicyClient } from "../ws-policy-close.js";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayConnectPhaseContext } from "./message-handler-types.js";

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
  context.sendHandshakeErrorResponse(ErrorCodes.FORBIDDEN, GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
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
