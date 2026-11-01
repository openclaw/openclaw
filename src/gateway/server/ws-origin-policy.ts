import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  isBrowserCopilotClient,
  isBrowserOperatorUiClient,
  isWebchatClient,
} from "../../utils/message-channel.js";
import { isGatewayAuthGrantCurrent, isGatewayAuthPolicyCurrent } from "../auth-policy.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { checkGatewayWsBrowserOrigin, normalizeChromeExtensionOrigin } from "../origin-check.js";
import { invalidateGatewayPolicyClient } from "./ws-policy-close.js";
import type { GatewayWsBrowserOrigin, GatewayWsClient } from "./ws-types.js";

/** Retain attested transport facts only for connections governed by browser-origin policy. */
export function resolveGatewayWsBrowserOrigin(
  params: GatewayWsBrowserOrigin & {
    client: ConnectParams["client"];
    enforceOriginCheckForAnyClient: boolean;
  },
): GatewayWsBrowserOrigin | undefined {
  // Extension origins are bound by device approval, independently of the host allowlist.
  if (isBrowserCopilotClient(params.client) && normalizeChromeExtensionOrigin(params.origin)) {
    return undefined;
  }
  if (
    !params.enforceOriginCheckForAnyClient &&
    !isBrowserOperatorUiClient(params.client) &&
    !isWebchatClient(params.client)
  ) {
    return undefined;
  }
  return {
    requestHost: params.requestHost,
    origin: params.origin,
    isLocalClient: params.isLocalClient,
    remoteControlUiIngress: params.remoteControlUiIngress,
  };
}

/** Revocation follows committed publication; unrelated authenticated connections remain live. */
export function disconnectDisallowedGatewayPolicyClients(
  clients: Iterable<
    Pick<
      GatewayWsClient,
      | "browserOrigin"
      | "invalidated"
      | "invalidatedReason"
      | "authPolicy"
      | "authenticatedUserProfile"
      | "internal"
    > & {
      connect?: Pick<ConnectParams, "role" | "scopes">;
      socket: Pick<GatewayWsClient["socket"], "close">;
    }
  >,
  cfg: OpenClawConfig,
): void {
  for (const client of clients) {
    if (client.browserOrigin && !checkGatewayWsBrowserOrigin(client.browserOrigin, cfg).ok) {
      invalidateGatewayPolicyClient(client, {
        reason: "origin-policy-changed",
        code: 1008,
        message: "origin not allowed",
      });
      continue;
    }
    let roleAuthorityRevoked = false;
    if (client.connect?.role === "operator") {
      try {
        const role = resolveOperatorRolePolicyForProfile(
          client.authenticatedUserProfile?.profileId,
          cfg,
        );
        roleAuthorityRevoked =
          role !== undefined &&
          (!roleScopesAllow({
            role: "operator",
            requestedScopes: client.connect.scopes ?? [],
            allowedScopes: role.scopes,
          }) ||
            role.accessPolicyPlugin !==
              client.internal?.operatorAccessAuthority?.requiredPolicyPlugin);
      } catch {
        // A retired profile cannot retain its connection's grants.
        roleAuthorityRevoked = true;
      }
    }
    if (roleAuthorityRevoked || !isGatewayAuthPolicyCurrent(client.authPolicy, cfg)) {
      invalidateGatewayPolicyClient(client, {
        reason: "gateway-policy-changed",
        code: 4001,
        message: "gateway policy changed",
        revokeSource: roleAuthorityRevoked || !isGatewayAuthGrantCurrent(client.authPolicy, cfg),
      });
    }
  }
}
