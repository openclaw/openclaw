import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayConnectionAuth } from "./connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { ExplicitGatewayAuth } from "./credentials.js";

/** Convert connection-detail source labels into credential lookup override sources. */
export function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined {
  if (urlSource === "cli --url") {
    return "cli";
  }
  if (urlSource === "env OPENCLAW_GATEWAY_URL") {
    return "env";
  }
  return undefined;
}

/**
 * Resolve the Gateway URL and auth material used by non-interactive clients.
 * CLI/env URL overrides are passed into credential resolution so remote
 * credential selection follows the same target that the client will dial.
 */
export async function resolveGatewayClientBootstrap(params: {
  config: OpenClawConfig;
  gatewayUrl?: string;
  explicitAuth?: ExplicitGatewayAuth;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  url: string;
  urlSource: string;
  preauthHandshakeTimeoutMs?: number;
  auth: {
    token?: string;
    password?: string;
  };
}> {
  const connection = buildGatewayConnectionDetailsWithResolvers({
    config: params.config,
    url: params.gatewayUrl,
  });
  const urlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
  // Only CLI/env overrides become credential override context; config/default
  // targets should use the normal Gateway auth precedence for that config.
  const auth = await resolveGatewayConnectionAuth({
    config: params.config,
    explicitAuth: params.explicitAuth,
    env: params.env ?? process.env,
    urlOverride: urlOverrideSource ? connection.url : undefined,
    urlOverrideSource,
  });
  return {
    url: connection.url,
    urlSource: connection.urlSource,
    preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs,
    auth,
  };
}
