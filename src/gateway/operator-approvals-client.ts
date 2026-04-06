import type { OpenClawConfig } from "../config/config.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

export async function createOperatorApprovalsGatewayClient(
  params: Pick<
    GatewayClientOptions,
    "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.approvals"],
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onClose: params.onClose,
  });
}
