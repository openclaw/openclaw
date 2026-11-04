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
import { resolveProfileActivityViewerId } from "../session-profile-activity-policy.js";
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
      | "profileActivity"
    > & {
      connect?: GatewayWsClient["connect"];
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
    let currentRole: ReturnType<typeof resolveOperatorRolePolicyForProfile> = undefined;
    if (client.connect?.role === "operator") {
      try {
        currentRole = resolveOperatorRolePolicyForProfile(
          client.authenticatedUserProfile?.profileId,
          cfg,
        );
        roleAuthorityRevoked =
          currentRole !== undefined &&
          (!roleScopesAllow({
            role: "operator",
            requestedScopes: client.connect.scopes ?? [],
            allowedScopes: currentRole.scopes,
          }) ||
            currentRole.accessPolicyPlugin !==
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
      continue;
    }
    // A presentation refresh fences new requests without revoking accepted work.
    // Stronger revocation above still runs for retained, already-fenced sources.
    if (!client.invalidated && client.profileActivity && client.connect) {
      const viewerId = resolveProfileActivityViewerId(
        {
          connect: client.connect,
          internal: client.internal,
          authenticatedUserProfile: client.authenticatedUserProfile,
        },
        currentRole?.scopes,
        client.authenticatedUserProfile?.profileId,
      );
      if (viewerId !== client.profileActivity.viewerId) {
        invalidateGatewayPolicyClient(client, {
          reason: "profile-activity-policy-changed",
          code: 4001,
          message: "gateway policy changed",
          revokeSource: false,
        });
      }
    }
  }
}
