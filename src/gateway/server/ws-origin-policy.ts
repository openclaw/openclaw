import type { ConnectParams } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { resolveControlUiAllowedOrigins } from "../../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isBrowserCopilotClient,
  isBrowserOperatorUiClient,
  isWebchatClient,
} from "../../utils/message-channel.js";
import { resolveGatewayAuthPolicyGeneration } from "../auth-policy.js";
import { checkBrowserOrigin, normalizeChromeExtensionOrigin } from "../origin-check.js";
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
  };
}

export function checkGatewayWsBrowserOrigin(origin: GatewayWsBrowserOrigin, cfg: OpenClawConfig) {
  return checkBrowserOrigin({
    ...origin,
    allowedOrigins: resolveControlUiAllowedOrigins(cfg),
    allowHostHeaderOriginFallback:
      cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
  });
}

/** Revocation follows committed publication; unrelated authenticated connections remain live. */
export function disconnectDisallowedGatewayPolicyClients(
  clients: Iterable<
    Pick<
      GatewayWsClient,
      "browserOrigin" | "invalidated" | "invalidatedReason" | "authPolicyGeneration"
    > & {
      socket: Pick<GatewayWsClient["socket"], "close">;
    }
  >,
  cfg: OpenClawConfig,
): void {
  const generation = resolveGatewayAuthPolicyGeneration(cfg);
  for (const client of clients) {
    if (client.authPolicyGeneration !== undefined && client.authPolicyGeneration !== generation) {
      invalidateGatewayPolicyClient(client, {
        reason: "gateway-policy-changed",
        code: 4001,
        message: "gateway policy changed",
      });
    } else if (client.browserOrigin && !checkGatewayWsBrowserOrigin(client.browserOrigin, cfg).ok) {
      invalidateGatewayPolicyClient(client, {
        reason: "origin-policy-changed",
        code: 1008,
        message: "origin not allowed",
      });
    }
  }
}
